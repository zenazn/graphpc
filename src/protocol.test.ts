import { describe, it, expect } from "bun:test";
import { parseClientMessage, parseServerMessage } from "./protocol.ts";

// ---------------------------------------------------------------------------
// parseClientMessage
// ---------------------------------------------------------------------------

describe("parseClientMessage", () => {
  describe("valid messages", () => {
    it("accepts edge without args", () => {
      const msg = parseClientMessage({ op: "edge", tok: 0, edge: "users" });
      expect(msg).toEqual({ op: "edge", tok: 0, edge: "users" });
    });

    it("accepts edge with args", () => {
      const msg = parseClientMessage({
        op: "edge",
        tok: 1,
        edge: "byId",
        args: [42],
      });
      expect(msg).toEqual({ op: "edge", tok: 1, edge: "byId", args: [42] });
    });

    it("accepts get without args", () => {
      const msg = parseClientMessage({ op: "get", tok: 5, name: "count" });
      expect(msg).toEqual({ op: "get", tok: 5, name: "count" });
    });

    it("accepts get with args", () => {
      const msg = parseClientMessage({
        op: "get",
        tok: 3,
        name: "search",
        args: ["foo", 10],
      });
      expect(msg).toEqual({
        op: "get",
        tok: 3,
        name: "search",
        args: ["foo", 10],
      });
    });

    it("accepts data", () => {
      const msg = parseClientMessage({ op: "data", tok: 7 });
      expect(msg).toEqual({ op: "data", tok: 7 });
    });

    it("accepts tok: 0 (root)", () => {
      const msg = parseClientMessage({ op: "data", tok: 0 });
      expect(msg).toEqual({ op: "data", tok: 0 });
    });

    it("accepts empty string edge name", () => {
      const msg = parseClientMessage({ op: "edge", tok: 0, edge: "" });
      expect(msg).toEqual({ op: "edge", tok: 0, edge: "" });
    });

    it("accepts empty string get name", () => {
      const msg = parseClientMessage({ op: "get", tok: 0, name: "" });
      expect(msg).toEqual({ op: "get", tok: 0, name: "" });
    });
  });

  describe("rejects non-object inputs", () => {
    it("rejects null", () => {
      expect(() => parseClientMessage(null)).toThrow(
        "Expected object, got null",
      );
    });

    it("rejects array", () => {
      expect(() => parseClientMessage([1, 2])).toThrow("Expected object");
    });
  });

  describe("rejects unknown op", () => {
    it("rejects unknown op string", () => {
      expect(() => parseClientMessage({ op: "subscribe", tok: 0 })).toThrow(
        "Unknown client message op",
      );
    });

    it("rejects missing op", () => {
      expect(() => parseClientMessage({ tok: 0, edge: "x" })).toThrow(
        "Unknown client message op",
      );
    });

    it("rejects numeric op", () => {
      expect(() => parseClientMessage({ op: 1, tok: 0 })).toThrow(
        "Unknown client message op",
      );
    });
  });

  describe("rejects missing required keys", () => {
    it("edge: missing tok", () => {
      expect(() => parseClientMessage({ op: "edge", edge: "x" })).toThrow(
        'Invalid "edge" message keys',
      );
    });

    it("edge: missing edge", () => {
      expect(() => parseClientMessage({ op: "edge", tok: 0 })).toThrow(
        'Invalid "edge" message keys',
      );
    });

    it("get: missing tok", () => {
      expect(() => parseClientMessage({ op: "get", name: "x" })).toThrow(
        'Invalid "get" message keys',
      );
    });

    it("get: missing name", () => {
      expect(() => parseClientMessage({ op: "get", tok: 0 })).toThrow(
        'Invalid "get" message keys',
      );
    });

    it("data: missing tok", () => {
      expect(() => parseClientMessage({ op: "data" })).toThrow(
        'Invalid "data" message keys',
      );
    });
  });

  describe("rejects extra keys", () => {
    it("edge: extra key", () => {
      expect(() =>
        parseClientMessage({ op: "edge", tok: 0, edge: "x", extra: 1 }),
      ).toThrow('Invalid "edge" message keys');
    });

    it("edge: args not allowed to sneak extra", () => {
      expect(() =>
        parseClientMessage({
          op: "edge",
          tok: 0,
          edge: "x",
          args: [],
          name: "y",
        }),
      ).toThrow('Invalid "edge" message keys');
    });

    it("get: extra key", () => {
      expect(() =>
        parseClientMessage({ op: "get", tok: 0, name: "x", extra: 1 }),
      ).toThrow('Invalid "get" message keys');
    });

    it("data: args not allowed", () => {
      expect(() =>
        parseClientMessage({ op: "data", tok: 0, args: [] }),
      ).toThrow('Invalid "data" message keys');
    });

    it("data: extra random key", () => {
      expect(() =>
        parseClientMessage({ op: "data", tok: 0, foo: "bar" }),
      ).toThrow('Invalid "data" message keys');
    });
  });

  describe("rejects wrong types", () => {
    it("tok must be a non-negative integer", () => {
      expect(() =>
        parseClientMessage({ op: "edge", tok: "0", edge: "x" }),
      ).toThrow("non-negative integer");
      expect(() =>
        parseClientMessage({ op: "edge", tok: 1.5, edge: "x" }),
      ).toThrow("non-negative integer");
      expect(() =>
        parseClientMessage({ op: "get", tok: NaN, name: "x" }),
      ).toThrow("non-negative integer");
      expect(() => parseClientMessage({ op: "data", tok: true })).toThrow(
        "non-negative integer",
      );
    });

    it("string fields must be strings", () => {
      expect(() =>
        parseClientMessage({ op: "edge", tok: 0, edge: 42 }),
      ).toThrow("must be a string");
      expect(() =>
        parseClientMessage({ op: "get", tok: 0, name: null }),
      ).toThrow("must be a string");
    });

    it("args must be an array", () => {
      expect(() =>
        parseClientMessage({
          op: "edge",
          tok: 0,
          edge: "x",
          args: "not-array",
        }),
      ).toThrow("must be an array");
      expect(() =>
        parseClientMessage({ op: "edge", tok: 0, edge: "x", args: {} }),
      ).toThrow("must be an array");
      expect(() =>
        parseClientMessage({ op: "get", tok: 0, name: "x", args: 123 }),
      ).toThrow("must be an array");
    });
  });
});

// ---------------------------------------------------------------------------
// parseServerMessage
// ---------------------------------------------------------------------------

describe("parseServerMessage", () => {
  describe("valid messages", () => {
    it("accepts hello with populated schema", () => {
      const msg = parseServerMessage({
        op: "hello",
        version: 1,
        schema: [
          { edges: { users: 1, posts: 2 } },
          { edges: {} },
          { edges: { author: 1 } },
        ],
      });
      expect(msg.op).toBe("hello");
    });

    it("accepts hello with empty schema", () => {
      const msg = parseServerMessage({ op: "hello", version: 1, schema: [] });
      expect(msg).toEqual({ op: "hello", version: 1, schema: [] });
    });

    it("accepts edge success", () => {
      const msg = parseServerMessage({ op: "edge", tok: 5, re: 1 });
      expect(msg).toEqual({ op: "edge", tok: 5, re: 1 });
    });

    it("accepts edge failure", () => {
      const msg = parseServerMessage({
        op: "edge",
        tok: 5,
        re: 1,
        error: "boom",
      });
      expect(msg).toEqual({ op: "edge", tok: 5, re: 1, error: "boom" });
    });

    it("accepts get success", () => {
      const msg = parseServerMessage({
        op: "get",
        tok: 3,
        re: 2,
        data: { foo: "bar" },
      });
      expect(msg).toEqual({ op: "get", tok: 3, re: 2, data: { foo: "bar" } });
    });

    it("accepts get failure", () => {
      const msg = parseServerMessage({
        op: "get",
        tok: 3,
        re: 2,
        error: "not found",
      });
      expect(msg).toEqual({ op: "get", tok: 3, re: 2, error: "not found" });
    });

    it("accepts data success", () => {
      const msg = parseServerMessage({
        op: "data",
        tok: 0,
        re: 4,
        data: [1, 2, 3],
      });
      expect(msg).toEqual({ op: "data", tok: 0, re: 4, data: [1, 2, 3] });
    });

    it("accepts data failure", () => {
      const msg = parseServerMessage({
        op: "data",
        tok: 0,
        re: 4,
        error: null,
      });
      expect(msg).toEqual({ op: "data", tok: 0, re: 4, error: null });
    });

    it("accepts tok: 0 with re: 0", () => {
      const msg = parseServerMessage({ op: "edge", tok: 0, re: 0 });
      expect(msg).toEqual({ op: "edge", tok: 0, re: 0 });
    });
  });

  describe("rejects non-objects", () => {
    it("rejects null", () => {
      expect(() => parseServerMessage(null)).toThrow(
        "Expected object, got null",
      );
    });
  });

  describe("rejects unknown op", () => {
    it("rejects unknown op string", () => {
      expect(() => parseServerMessage({ op: "subscribe" })).toThrow(
        "Unknown server message op",
      );
    });

    it("rejects missing op", () => {
      expect(() => parseServerMessage({ tok: 0, re: 1 })).toThrow(
        "Unknown server message op",
      );
    });
  });
});
