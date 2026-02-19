import { test, expect } from "bun:test";
import { createSerializer } from "./serialization.ts";
import {
  RpcError,
  ValidationError,
  EdgeNotFoundError,
  ConnectionLostError,
  PoisonedTokenError,
} from "./errors.ts";
import { Reference } from "./ref.ts";

test("roundtrip arrays and objects", () => {
  const s = createSerializer();
  const obj = { a: [1, 2], b: { c: "d" } };
  expect(s.parse(s.stringify(obj))).toEqual(obj);
});

test("roundtrip Date", () => {
  const s = createSerializer();
  const date = new Date("2024-01-01");
  const result = s.parse(s.stringify(date)) as Date;
  expect(result).toBeInstanceOf(Date);
  expect(result.getTime()).toBe(date.getTime());
});

test("roundtrip Map and Set", () => {
  const s = createSerializer();
  const map = new Map([["a", 1]]);
  const set = new Set([1, 2, 3]);
  expect(s.parse(s.stringify(map))).toEqual(map);
  expect(s.parse(s.stringify(set))).toEqual(set);
});

test("roundtrip Reference", () => {
  const s = createSerializer();
  const r = new Reference(["users", ["get", "1"]], { name: "Alice" });
  const result = s.parse(s.stringify(r)) as Reference<unknown>;
  expect(result).toBeInstanceOf(Reference);
  expect(result.data).toEqual({ name: "Alice" });
  expect(result.path).toEqual(["users", ["get", "1"]]);
});

test("roundtrip Reference inside a Map", () => {
  const s = createSerializer();
  const r = new Reference(["tweets", ["get", "1"]], { id: "1", text: "hi" });
  const map = new Map([["tweet", r]]);
  const result = s.parse(s.stringify(map)) as Map<string, any>;
  expect(result).toBeInstanceOf(Map);
  const val = result.get("tweet");
  expect(val).toBeInstanceOf(Reference);
  expect(val.data).toEqual({ id: "1", text: "hi" });
  expect(val.path).toEqual(["tweets", ["get", "1"]]);
});

test("roundtrip Reference inside a Set", () => {
  const s = createSerializer();
  const r = new Reference(["tweets", ["get", "2"]], { id: "2" });
  const set = new Set([r]);
  const result = s.parse(s.stringify(set)) as Set<any>;
  expect(result).toBeInstanceOf(Set);
  const [val] = result;
  expect(val).toBeInstanceOf(Reference);
  expect(val.data).toEqual({ id: "2" });
  expect(val.path).toEqual(["tweets", ["get", "2"]]);
});

test("roundtrip Reference nested in objects and arrays", () => {
  const s = createSerializer();
  const r = new Reference(["users", ["get", "3"]], { name: "Bob" });
  const value = { items: [r], nested: { ref: r } };
  const result = s.parse(s.stringify(value)) as any;
  expect(result.items[0]).toBeInstanceOf(Reference);
  expect(result.items[0].data).toEqual({ name: "Bob" });
  expect(result.nested.ref).toBeInstanceOf(Reference);
  expect(result.nested.ref.path).toEqual(["users", ["get", "3"]]);
});

test("roundtrip RpcError subtypes", () => {
  const s = createSerializer();

  const err1 = new EdgeNotFoundError("missing");
  const r1 = s.parse(s.stringify(err1)) as EdgeNotFoundError;
  expect(r1).toBeInstanceOf(EdgeNotFoundError);
  expect(r1.edge).toBe("missing");

  const err2 = new ValidationError([{ message: "bad" }]);
  const r2 = s.parse(s.stringify(err2)) as ValidationError;
  expect(r2).toBeInstanceOf(ValidationError);
  expect(r2.issues[0]!.message).toBe("bad");
});

test("roundtrip ConnectionLostError", () => {
  const s = createSerializer();
  const err = new ConnectionLostError();
  const result = s.parse(s.stringify(err)) as ConnectionLostError;
  expect(result).toBeInstanceOf(ConnectionLostError);
  expect(result.code).toBe("CONNECTION_LOST");
  expect(result.message).toBe("All reconnection attempts failed");
});

test("roundtrip PoisonedTokenError", () => {
  const s = createSerializer();
  const cause = new EdgeNotFoundError("x");
  const err = new PoisonedTokenError(5, cause);
  const result = s.parse(s.stringify(err)) as PoisonedTokenError;
  expect(result).toBeInstanceOf(PoisonedTokenError);
  expect(result.token).toBe(5);
  expect(result.originalError).toBeInstanceOf(EdgeNotFoundError);
});

test("reducer returning falsy values is treated as not handled", () => {
  const s = createSerializer({
    reducers: {
      ReturnZero: () => 0 as any,
      ReturnEmpty: () => "" as any,
      ReturnNull: () => null as any,
      ReturnFalse: () => false,
      ReturnUndefined: () => undefined as any,
    },
  });

  // All reducers return falsy values, so the value should pass through as a plain object
  const obj = { x: 1 };

  const stringified = s.parse(s.stringify(obj)) as any;
  expect(stringified).toEqual(obj);
});

test("revive reconstitutes pre-parsed devalue output", () => {
  const s = createSerializer();
  const obj = { a: 1, b: [2, 3] };
  const str = s.stringify(obj);
  // Simulate what happens in browser: stringify output is embedded as JS,
  // browser evaluates it to a plain array, then revive unflatten's it.
  const preParsed = JSON.parse(str);
  expect(s.revive(preParsed)).toEqual(obj);
});

test("revive reconstitutes custom types from pre-parsed input", () => {
  const r = new Reference(["users", ["get", "1"]], { name: "Alice" });
  const s = createSerializer();
  const str = s.stringify(r);
  const preParsed = JSON.parse(str);
  const result = s.revive(preParsed) as Reference<unknown>;
  expect(result).toBeInstanceOf(Reference);
  expect(result.data).toEqual({ name: "Alice" });
  expect(result.path).toEqual(["users", ["get", "1"]]);
});

test("built-in names cannot be overridden by user reducers/revivers", () => {
  const s = createSerializer({
    reducers: {
      ValidationError: () => [["hijacked"]],
    },
    revivers: {
      ValidationError: () => "hijacked",
    },
  });

  const err = new ValidationError([{ message: "real" }]);
  const result = s.parse(s.stringify(err)) as ValidationError;
  expect(result).toBeInstanceOf(ValidationError);
  expect(result.issues[0]!.message).toBe("real");
});

test("RpcError subclass serializes as subclass, not as plain RpcError", () => {
  class CustomRpcError extends RpcError {
    constructor(public detail: string) {
      super("CUSTOM", detail);
    }
  }

  const s = createSerializer({
    reducers: {
      CustomRpcError: (v) => v instanceof CustomRpcError && [v.detail],
    },
    revivers: {
      CustomRpcError: ([detail]: any) => new CustomRpcError(detail),
    },
  });

  const err = new CustomRpcError("something went wrong");
  const result = s.parse(s.stringify(err)) as CustomRpcError;
  expect(result).toBeInstanceOf(CustomRpcError);
  expect(result).toBeInstanceOf(RpcError);
  expect(result.detail).toBe("something went wrong");
  expect(result.code).toBe("CUSTOM");
});

test("handles() returns true for a value matched by a user-supplied reducer", () => {
  class Custom {
    constructor(public x: number) {}
  }

  const s = createSerializer({
    reducers: { Custom: (v) => v instanceof Custom && [v.x] },
  });

  expect(s.handles(new Custom(1))).toBe(true);
});

test("handles() returns false for a value with no matching reducer", () => {
  class Custom {
    constructor(public x: number) {}
  }

  const s = createSerializer({
    reducers: { Custom: (v) => v instanceof Custom && [v.x] },
  });

  expect(s.handles({ x: 1 })).toBe(false);
  expect(s.handles("hello")).toBe(false);
});

test("handles() returns false for values matched only by builtin reducers", () => {
  const s = createSerializer();

  expect(s.handles(new RpcError("TEST", "test"))).toBe(false);
  expect(s.handles(new ValidationError([]))).toBe(false);
});

test("custom reducers/revivers", () => {
  class Foo {
    constructor(public x: number) {}
  }

  const s = createSerializer({
    reducers: {
      Foo: (v) => v instanceof Foo && [v.x],
    },
    revivers: {
      Foo: ([x]: any) => new Foo(x),
    },
  });

  const result = s.parse(s.stringify(new Foo(42))) as Foo;
  expect(result).toBeInstanceOf(Foo);
  expect(result.x).toBe(42);
});
