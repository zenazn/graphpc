import { test, expect } from "bun:test";
import { HydrationCache, validateHydrationData } from "./hydration.ts";
import { formatPath } from "./format.ts";
import type { HydrationData } from "./ssr.ts";
import { fakeTimers } from "./test-utils.ts";

function makeCache(opts?: { timeout?: number; timers?: any }) {
  return new HydrationCache({
    timeout: opts?.timeout ?? 1000,
    ...opts,
  });
}

/** Minimal hydration data for testing. */
function makeHydrationData(overrides?: Partial<HydrationData>): HydrationData {
  return {
    schema: [{ edges: { posts: 1 } }, { edges: { get: 2 } }, { edges: {} }],
    refs: [
      [0, "posts"], // token 1
      [1, "get", "1"], // token 2
    ],
    data: [
      [2, { id: "1", title: "Hello" }], // data for token 2
      [1, "count", [], 42], // call: posts.count() = 42
    ],
    ...overrides,
  };
}

// --- Tests ---

test("activate + data lookup hit", () => {
  const cache = makeCache();
  const schema = cache.activate(makeHydrationData());

  expect(cache.isActive()).toBe(true);
  expect(schema.length).toBe(3);

  // Lookup data for posts.get("1") → edgePath is ["posts", ["get", "1"]]
  const key = formatPath(["posts", ["get", "1"]]);
  const result = cache.lookup(key, null);
  expect(result.hit).toBe(true);
  expect((result as any).value).toEqual({ id: "1", title: "Hello" });
});

test("activate + method call lookup hit", () => {
  const cache = makeCache();
  cache.activate(makeHydrationData());

  // Lookup call for posts.count() → edgePath is ["posts"], terminal is { name: "count", args: [] }
  const key = formatPath(["posts"]);
  const result = cache.lookup(key, { name: "count", args: [] });
  expect(result.hit).toBe(true);
  expect((result as any).value).toBe(42);
});

test("lookup returns { hit: false } for data cache miss", () => {
  const cache = makeCache();
  cache.activate(makeHydrationData());

  // Unknown path
  const key = formatPath(["unknown"]);
  const result = cache.lookup(key, null);
  expect(result.hit).toBe(false);
});

test("property read hits data cache when no call entry exists", () => {
  const cache = makeCache();
  cache.activate(makeHydrationData());

  // posts.get("1") has data { id: "1", title: "Hello" } but no call entry for "title"
  const key = formatPath(["posts", ["get", "1"]]);
  const result = cache.lookup(key, { name: "title", args: [] });
  expect(result.hit).toBe(true);
  expect((result as any).value).toBe("Hello");
});

test("property read from data cache misses for absent properties", () => {
  const cache = makeCache();
  cache.activate(makeHydrationData());

  const key = formatPath(["posts", ["get", "1"]]);
  const result = cache.lookup(key, { name: "nonexistent", args: [] });
  expect(result.hit).toBe(false);
});

test("method call with args does not cross-reference data cache", () => {
  const cache = makeCache();
  cache.activate(makeHydrationData());

  // A method call (args.length > 0) should NOT fall through to data cache
  const key = formatPath(["posts", ["get", "1"]]);
  const result = cache.lookup(key, { name: "title", args: ["extra"] });
  expect(result.hit).toBe(false);
});

test("lookup returns { hit: false } for method call cache miss", () => {
  const cache = makeCache();
  cache.activate(makeHydrationData());

  // Known path but unknown method
  const key = formatPath(["posts"]);
  const result = cache.lookup(key, { name: "unknownMethod", args: [] });
  expect(result.hit).toBe(false);
});

test("lookup returns { hit: false } when not active", () => {
  const cache = makeCache();
  // Not activated
  const key = formatPath(["posts"]);
  const result = cache.lookup(key, null);
  expect(result.hit).toBe(false);
});

test("multiple lookups don't consume entries", () => {
  const cache = makeCache();
  cache.activate(makeHydrationData());

  const key = formatPath(["posts", ["get", "1"]]);

  const r1 = cache.lookup(key, null);
  const r2 = cache.lookup(key, null);
  const r3 = cache.lookup(key, null);

  expect(r1.hit).toBe(true);
  expect(r2.hit).toBe(true);
  expect(r3.hit).toBe(true);
  expect((r1 as any).value).toEqual((r2 as any).value);
  expect((r2 as any).value).toEqual((r3 as any).value);
});

test("inactivity timer starts after last lookup's microtask resolves", async () => {
  const ft = fakeTimers();
  const cache = makeCache({ timeout: 500, timers: ft });
  cache.activate(makeHydrationData());

  const key = formatPath(["posts", ["get", "1"]]);
  cache.lookup(key, null);

  // Timer not started yet (in-flight microtask hasn't resolved)
  expect(ft.pending()).toBe(0);

  // Drain microtask queue
  await Promise.resolve();

  // Now the inactivity timer should be pending
  expect(ft.pending()).toBe(1);
  expect(ft.getDelay()).toBe(500);
  expect(cache.isActive()).toBe(true);
});

test("inactivity timeout drops cache", async () => {
  const ft = fakeTimers();
  const cache = makeCache({ timeout: 500, timers: ft });
  cache.activate(makeHydrationData());

  const key = formatPath(["posts", ["get", "1"]]);
  cache.lookup(key, null);

  // Drain microtask
  await Promise.resolve();

  // Fire the inactivity timer
  ft.fire();

  expect(cache.isActive()).toBe(false);

  // Subsequent lookups miss
  const result = cache.lookup(key, null);
  expect(result.hit).toBe(false);
});

test("new lookup cancels pending inactivity timer", async () => {
  const ft = fakeTimers();
  const cache = makeCache({ timeout: 500, timers: ft });
  cache.activate(makeHydrationData());

  const dataKey = formatPath(["posts", ["get", "1"]]);
  const callKey = formatPath(["posts"]);

  // First lookup
  cache.lookup(dataKey, null);
  await Promise.resolve();
  expect(ft.pending()).toBe(1);

  // Second lookup — should cancel the first timer
  cache.lookup(callKey, { name: "count", args: [] });
  // The new lookup immediately cancels the old timer
  expect(ft.pending()).toBe(0);

  // After microtask, a new timer is set
  await Promise.resolve();
  expect(ft.pending()).toBe(1);

  // Cache is still active
  expect(cache.isActive()).toBe(true);
});

test("drop() clears immediately and is idempotent", () => {
  const ft = fakeTimers();
  const cache = makeCache({ timeout: 500, timers: ft });
  cache.activate(makeHydrationData());

  expect(cache.isActive()).toBe(true);
  cache.drop();
  expect(cache.isActive()).toBe(false);

  // Second drop is a no-op
  cache.drop();
  expect(cache.isActive()).toBe(false);

  // No timers left
  expect(ft.pending()).toBe(0);
});

test("drop() clears pending inactivity timer", async () => {
  const ft = fakeTimers();
  const cache = makeCache({ timeout: 500, timers: ft });
  cache.activate(makeHydrationData());

  const key = formatPath(["posts", ["get", "1"]]);
  cache.lookup(key, null);
  await Promise.resolve();
  expect(ft.pending()).toBe(1);

  cache.drop();
  expect(ft.pending()).toBe(0);
  expect(cache.isActive()).toBe(false);
});

test("root path lookup (edgePath=[]) works", () => {
  const cache = makeCache();
  cache.activate({
    schema: [{ edges: {} }],
    refs: [],
    data: [[0, { name: "root" }]],
  });

  const key = formatPath([]);
  const result = cache.lookup(key, null);
  expect(result.hit).toBe(true);
  expect((result as any).value).toEqual({ name: "root" });
});

// --- Regression tests: rich types in cache keys ---

test("rich type args (Date, Map) don't collide with their string equivalents", () => {
  const date = new Date("2024-01-01");

  // Date edge arg vs ISO string
  const cache1 = makeCache();
  cache1.activate({
    schema: [{ edges: { byDate: 1 } }, { edges: {} }],
    refs: [[0, "byDate", date]],
    data: [[1, { found: "date-arg" }]],
  });
  expect(cache1.lookup(formatPath([["byDate", date]]), null).hit).toBe(true);
  expect(
    cache1.lookup(formatPath([["byDate", date.toISOString()]]), null).hit,
  ).toBe(false);

  // Map edge arg — hit/miss correctly
  const cache2 = makeCache();
  cache2.activate({
    schema: [{ edges: { lookup: 1 } }, { edges: {} }],
    refs: [[0, "lookup", new Map([["a", 1]])]],
    data: [[1, { result: "map-hit" }]],
  });
  const hitKey = formatPath([["lookup", new Map([["a", 1]])]]);
  expect(cache2.lookup(hitKey, null).hit).toBe(true);
  expect((cache2.lookup(hitKey, null) as any).value).toEqual({
    result: "map-hit",
  });
  expect(
    cache2.lookup(formatPath([["lookup", new Map([["b", 2]])]]), null).hit,
  ).toBe(false);

  // Method call with Date+Map args — hit/miss correctly
  const cache3 = makeCache();
  cache3.activate({
    schema: [{ edges: { svc: 1 } }, { edges: {} }],
    refs: [[0, "svc"]],
    data: [
      [
        1,
        "query",
        [new Date("2024-06-15"), new Map([["x", 10]])],
        "rich-result",
      ],
    ],
  });
  const pathKey = formatPath(["svc"]);
  const result = cache3.lookup(pathKey, {
    name: "query",
    args: [new Date("2024-06-15"), new Map([["x", 10]])],
  });
  expect(result.hit).toBe(true);
  expect((result as any).value).toBe("rich-result");
  expect(
    cache3.lookup(pathKey, {
      name: "query",
      args: [new Date("2025-01-01"), new Map([["x", 10]])],
    }).hit,
  ).toBe(false);
});

// --- validateHydrationData ---

test("validateHydrationData accepts valid data", () => {
  const data = makeHydrationData();
  expect(validateHydrationData(data)).toBe(data);
});

test("validateHydrationData rejects invalid inputs", () => {
  expect(() => validateHydrationData(null)).toThrow(TypeError);
  expect(() => validateHydrationData("not hydration data")).toThrow(TypeError);
  expect(() => validateHydrationData({ data: [], schema: [] })).toThrow(
    TypeError,
  );
  expect(() =>
    validateHydrationData({ refs: [], data: [], schema: "bad" }),
  ).toThrow(TypeError);
});
