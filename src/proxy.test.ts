import { test, expect } from "bun:test";
import { classifyPath, createDataProxy, type ProxyBackend } from "./proxy";
import type { Schema } from "./protocol";

// Schema: Root --child--> Child (no edges on Child)
const schema: Schema = [
  { edges: { child: 1 }, streams: [] }, // index 0: Root
  { edges: {}, streams: [] }, // index 1: Child
];

test("classifyPath throws on extra segments after terminal (not an edge)", () => {
  // "method" is terminal on Root, "extra" is leftover
  expect(() => classifyPath(["method", "extra"], schema)).toThrow(
    /Invalid path root\.method\.extra: "method" at position 0 is not an edge/,
  );
});

test("classifyPath throws on extra segments after terminal past an edge", () => {
  // "child" is an edge, "method" is terminal on Child, "extra" is leftover
  expect(() => classifyPath(["child", "method", "extra"], schema)).toThrow(
    /Invalid path root\.child\.method\.extra: "method" at position 1 is not an edge/,
  );
});

test("classifyPath throws on extra segments when nodeSchema is missing", () => {
  // Schema with an edge that points to an index with no entry
  const sparse: Schema = [{ edges: { link: 5 }, streams: [] }]; // index 5 doesn't exist
  expect(() => classifyPath(["link", "a", "b"], sparse)).toThrow(
    /Invalid path root\.link\.a\.b: "a" at position 1 is not an edge/,
  );
});

test("classifyPath allows a single terminal segment (no extras)", () => {
  const result = classifyPath(["method"], schema);
  expect(result).toEqual({
    edgePath: [],
    terminal: { name: "method", args: [] },
  });
});

test("classifyPath allows edge then single terminal", () => {
  const result = classifyPath(["child", "method"], schema);
  expect(result).toEqual({
    edgePath: ["child"],
    terminal: { name: "method", args: [] },
  });
});

// -- Stream classification tests --

test("classifyPath identifies stream segments", () => {
  const streamSchema: Schema = [
    { edges: { child: 1 }, streams: [] }, // index 0: Root
    { edges: {}, streams: ["events", "updates"] }, // index 1: Child with streams
  ];

  const result = classifyPath(["child", "events"], streamSchema);
  expect(result.edgePath).toEqual(["child"]);
  expect(result.terminal).toBeNull();
  expect(result.stream).toEqual({ name: "events", args: [] });
});

test("classifyPath identifies stream with args", () => {
  const streamSchema: Schema = [
    { edges: { child: 1 }, streams: [] },
    { edges: {}, streams: ["events"] },
  ];

  const result = classifyPath(
    ["child", ["events", "cursor-123"]],
    streamSchema,
  );
  expect(result.stream).toEqual({ name: "events", args: ["cursor-123"] });
});

test("classifyPath throws when stream is not at the end", () => {
  const streamSchema: Schema = [{ edges: {}, streams: ["events"] }];

  expect(() => classifyPath(["events", "extra"], streamSchema)).toThrow(
    /stream/i,
  );
});

test("createDataProxy does not return Object.prototype.toString", () => {
  const backend: ProxyBackend = {
    resolve: () => Promise.resolve({}),
  };

  const proxy = createDataProxy(backend, [], { name: "test", value: 42 });
  expect(proxy.toString).not.toBe(Object.prototype.toString);
});

test("createDataProxy does not return Object.prototype.constructor", () => {
  const backend: ProxyBackend = {
    resolve: () => Promise.resolve({}),
  };

  const proxy = createDataProxy(backend, [], { name: "test" });
  expect(proxy.constructor).not.toBe(Object);
});

test("createDataProxy returns own data properties correctly", () => {
  const backend: ProxyBackend = {
    resolve: () => Promise.resolve({}),
  };

  const proxy = createDataProxy(backend, [], {
    name: "test",
    count: 0,
    empty: "",
  });

  expect(proxy.name).toBe("test");
  expect(proxy.count).toBe(0);
  expect(proxy.empty).toBe("");
});
