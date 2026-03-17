import { describe, it, expect } from "bun:test";
import { parseClientMessage, parseServerMessage } from "./protocol";

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

    it("accepts valid stream_start", () => {
      const msg = parseClientMessage({
        op: "stream_start",
        tok: 1,
        stream: "count",
        credits: 8,
      });
      expect(msg).toEqual({
        op: "stream_start",
        tok: 1,
        stream: "count",
        credits: 8,
      });
    });

    it("accepts stream_start with args", () => {
      const msg = parseClientMessage({
        op: "stream_start",
        tok: 0,
        stream: "events",
        args: ["cursor-123"],
        credits: 4,
      });
      expect(msg).toEqual({
        op: "stream_start",
        tok: 0,
        stream: "events",
        args: ["cursor-123"],
        credits: 4,
      });
    });

    it("accepts valid stream_credit", () => {
      const msg = parseClientMessage({
        op: "stream_credit",
        sid: -1,
        credits: 4,
      });
      expect(msg).toEqual({ op: "stream_credit", sid: -1, credits: 4 });
    });

    it("accepts valid stream_cancel", () => {
      const msg = parseClientMessage({
        op: "stream_cancel",
        sid: -3,
      });
      expect(msg).toEqual({ op: "stream_cancel", sid: -3 });
    });

    it("accepts empty string edge name", () => {
      const msg = parseClientMessage({ op: "edge", tok: 0, edge: "" });
      expect(msg).toEqual({ op: "edge", tok: 0, edge: "" });
    });

    it("accepts empty string get name", () => {
      const msg = parseClientMessage({ op: "get", tok: 0, name: "" });
      expect(msg).toEqual({ op: "get", tok: 0, name: "" });
    });

    it("accepts pong", () => {
      const msg = parseClientMessage({ op: "pong" });
      expect(msg).toEqual({ op: "pong" });
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

    it("pong: extra key", () => {
      expect(() => parseClientMessage({ op: "pong", extra: 1 })).toThrow(
        'Invalid "pong" message keys',
      );
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

    it("stream_credit with non-negative sid rejected", () => {
      expect(() =>
        parseClientMessage({ op: "stream_credit", sid: 0, credits: 4 }),
      ).toThrow("negative integer");
      expect(() =>
        parseClientMessage({ op: "stream_credit", sid: 1, credits: 4 }),
      ).toThrow("negative integer");
    });

    it("stream_cancel with non-negative sid rejected", () => {
      expect(() => parseClientMessage({ op: "stream_cancel", sid: 0 })).toThrow(
        "negative integer",
      );
    });

    it("stream_start with zero credits rejected", () => {
      expect(() =>
        parseClientMessage({
          op: "stream_start",
          tok: 0,
          stream: "x",
          credits: 0,
        }),
      ).toThrow("positive integer");
    });

    it("stream_start with negative credits rejected", () => {
      expect(() =>
        parseClientMessage({
          op: "stream_start",
          tok: 0,
          stream: "x",
          credits: -1,
        }),
      ).toThrow("positive integer");
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
        version: 2,
        tokenWindow: 10000,
        maxStreams: 32,
        schema: [
          { edges: { users: 1, posts: 2 }, streams: [] },
          { edges: {}, streams: [] },
          { edges: { author: 1 }, streams: [] },
        ],
      });
      expect(msg.op).toBe("hello");
    });

    it("accepts hello with empty schema", () => {
      const msg = parseServerMessage({
        op: "hello",
        version: 2,
        tokenWindow: 10000,
        maxStreams: 32,
        schema: [],
      });
      expect(msg).toEqual({
        op: "hello",
        version: 2,
        tokenWindow: 10000,
        maxStreams: 32,
        schema: [],
      });
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

    it("accepts stream_start success", () => {
      const msg = parseServerMessage({ op: "stream_start", sid: -1, re: 3 });
      expect(msg.op).toBe("stream_start");
    });

    it("accepts stream_start failure", () => {
      const msg = parseServerMessage({
        op: "stream_start",
        sid: -1,
        re: 3,
        error: "limit exceeded",
      });
      expect(msg.op).toBe("stream_start");
      expect((msg as { error?: unknown }).error).toBe("limit exceeded");
    });

    it("accepts stream_data", () => {
      const msg = parseServerMessage({
        op: "stream_data",
        sid: -1,
        data: { value: 42 },
      });
      expect(msg.op).toBe("stream_data");
      expect((msg as { data?: unknown }).data).toEqual({ value: 42 });
    });

    it("accepts stream_end without error", () => {
      const msg = parseServerMessage({ op: "stream_end", sid: -1 });
      expect(msg.op).toBe("stream_end");
    });

    it("accepts stream_end with error", () => {
      const msg = parseServerMessage({
        op: "stream_end",
        sid: -2,
        error: "boom",
      });
      expect(msg.op).toBe("stream_end");
      expect((msg as { error?: unknown }).error).toBe("boom");
    });

    it("accepts ping", () => {
      const msg = parseServerMessage({ op: "ping" });
      expect(msg).toEqual({ op: "ping" });
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
