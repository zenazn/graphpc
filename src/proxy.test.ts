import { test, expect } from "bun:test";
import { classifyPath } from "./proxy.ts";
import type { Schema } from "./protocol.ts";

// Schema: Root --child--> Child (no edges on Child)
const schema: Schema = [
  { edges: { child: 1 } }, // index 0: Root
  { edges: {} }, // index 1: Child
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
  const sparse: Schema = [{ edges: { link: 5 } }]; // index 5 doesn't exist
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
