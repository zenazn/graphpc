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

test("Date edge arg does not collide with its ISO string", () => {
  const date = new Date("2024-01-01");
  const isoString = date.toISOString(); // "2024-01-01T00:00:00.000Z"

  const cache = makeCache();
  cache.activate({
    schema: [{ edges: { byDate: 1 } }, { edges: {} }],
    refs: [
      [0, "byDate", date], // token 1: byDate(Date)
    ],
    data: [[1, { found: "date-arg" }]],
  });

  // Date arg should hit — fullPath is [["byDate", date]]
  const dateKey = formatPath([["byDate", date]]);
  expect(cache.lookup(dateKey, null).hit).toBe(true);

  // ISO string arg should miss — different cache key
  const stringKey = formatPath([["byDate", isoString]]);
  expect(cache.lookup(stringKey, null).hit).toBe(false);
});

test("Map edge args produce correct cache keys", () => {
  const m = new Map([["a", 1]]);

  const cache = makeCache();
  cache.activate({
    schema: [{ edges: { lookup: 1 } }, { edges: {} }],
    refs: [
      [0, "lookup", m], // token 1: lookup(Map)
    ],
    data: [[1, { result: "map-hit" }]],
  });

  // Same Map value should hit
  const hitKey = formatPath([["lookup", new Map([["a", 1]])]]);
  expect(cache.lookup(hitKey, null).hit).toBe(true);
  expect((cache.lookup(hitKey, null) as any).value).toEqual({
    result: "map-hit",
  });

  // Different Map should miss
  const missKey = formatPath([["lookup", new Map([["b", 2]])]]);
  expect(cache.lookup(missKey, null).hit).toBe(false);
});

test("method call cache key with Date/Map args works", () => {
  const date = new Date("2024-06-15");
  const m = new Map([["x", 10]]);

  const cache = makeCache();
  cache.activate({
    schema: [{ edges: { svc: 1 } }, { edges: {} }],
    refs: [[0, "svc"]], // token 1
    data: [[1, "query", [date, m], "rich-result"]], // call: svc.query(date, map) = "rich-result"
  });

  const pathKey = formatPath(["svc"]);

  // Same args should hit
  const result = cache.lookup(pathKey, {
    name: "query",
    args: [new Date("2024-06-15"), new Map([["x", 10]])],
  });
  expect(result.hit).toBe(true);
  expect((result as any).value).toBe("rich-result");

  // Different args should miss
  const miss = cache.lookup(pathKey, {
    name: "query",
    args: [new Date("2025-01-01"), new Map([["x", 10]])],
  });
  expect(miss.hit).toBe(false);
});

// --- validateHydrationData ---

test("validateHydrationData accepts valid data", () => {
  const data = makeHydrationData();
  expect(validateHydrationData(data)).toBe(data);
});

test("validateHydrationData rejects null", () => {
  expect(() => validateHydrationData(null)).toThrow(TypeError);
});

test("validateHydrationData rejects string", () => {
  expect(() => validateHydrationData("not hydration data")).toThrow(TypeError);
});

test("validateHydrationData rejects object missing refs", () => {
  expect(() => validateHydrationData({ data: [], schema: [] })).toThrow(
    TypeError,
  );
});

test("validateHydrationData rejects object with non-array schema", () => {
  expect(() =>
    validateHydrationData({ refs: [], data: [], schema: "bad" }),
  ).toThrow(TypeError);
});
