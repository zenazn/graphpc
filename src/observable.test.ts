import { test, expect } from "bun:test";
import { Node } from "./types";
import { edge } from "./decorators";
import { createServer } from "./server";
import { createClient, subscribe } from "./client";
import { toObservable, toStub } from "./observable";
import { STUB_PATH, STUB_BACKEND } from "./proxy";

class Item extends Node {
  name = "test";
}

class Api extends Node {
  @edge(() => Item, { schema: (await import("zod")).z.string() })
  get items() {
    return new Item();
  }

  @edge(() => Item, { schema: (await import("zod")).z.string() })
  itemById(_id: string) {
    return new Item();
  }
}

const server = createServer({}, () => new Api());

function makeClient() {
  return createClient<typeof server>({}, () => ({
    send() {},
    close() {},
    addEventListener() {},
    removeEventListener() {},
  }));
}

// -- toObservable basics --

test("toObservable(stub).subscribe is a function", () => {
  const client = makeClient();
  const obs = toObservable(client.root);
  expect(typeof obs.subscribe).toBe("function");
});

test(".subscribe(cb) calls cb synchronously with the observable wrapper", () => {
  const client = makeClient();
  const obs = toObservable(client.root);
  let receivedValue: unknown;
  obs.subscribe((value: unknown) => {
    receivedValue = value;
  });
  expect(receivedValue).toBe(obs);
});

test(".subscribe() return is callable and has .unsubscribe", () => {
  const client = makeClient();
  const obs = toObservable(client.root);
  const unsub = obs.subscribe(() => {});
  expect(typeof unsub).toBe("function");
  expect(typeof unsub.unsubscribe).toBe("function");
  expect(unsub.unsubscribe).toBe(unsub);
});

// -- Propagation --

test("observable propagates through edge navigation", () => {
  const client = makeClient();
  const obs = toObservable(client.root);
  const child = obs.items;
  expect(typeof child.subscribe).toBe("function");
});

test("observable propagates through edge calls", () => {
  const client = makeClient();
  const obs = toObservable(client.root);
  const child = obs.itemById("arg");
  expect(typeof child.subscribe).toBe("function");
});

// -- toStub roundtrip --

test("toStub(toObservable(stub)) returns the original raw stub", () => {
  const client = makeClient();
  const raw = client.root;
  const obs = toObservable(raw);
  expect(toStub(obs)).toBe(raw);
});

test("toStub(rawStub) returns input unchanged", () => {
  const client = makeClient();
  const raw = client.root;
  expect(toStub(raw)).toBe(raw);
});

// -- Idempotency --

test("toObservable(toObservable(stub)) returns same wrapper", () => {
  const client = makeClient();
  const obs = toObservable(client.root);
  expect(toObservable(obs)).toBe(obs);
});

// -- Graceful no-ops --

test("toObservable(nonStub) returns input unchanged", () => {
  const obj = { x: 1 };
  expect(toObservable(obj)).toBe(obj);
  expect(toObservable(42)).toBe(42);
  expect(toObservable(null)).toBe(null);
  expect(toObservable(undefined)).toBe(undefined);
});

test("toStub(nonObservable) returns input unchanged", () => {
  const obj = { x: 1 };
  expect(toStub(obj)).toBe(obj);
  expect(toStub(42)).toBe(42);
  expect(toStub(null)).toBe(null);
});

// -- Symbol pass-through --

test("STUB_PATH and STUB_BACKEND pass through observable", () => {
  const client = makeClient();
  const raw = client.root;
  const obs = toObservable(raw);
  expect((obs as { [STUB_PATH]?: unknown })[STUB_PATH]).toEqual(
    (raw as { [STUB_PATH]?: unknown })[STUB_PATH],
  );
  expect((obs as { [STUB_BACKEND]?: unknown })[STUB_BACKEND]).toBe(
    (raw as { [STUB_BACKEND]?: unknown })[STUB_BACKEND],
  );
});

test("standalone subscribe() works on observable stubs", () => {
  const client = makeClient();
  const obs = toObservable(client.root);
  let called = false;
  const unsub = subscribe(obs, () => {
    called = true;
  });
  expect(called).toBe(true);
  expect(typeof unsub).toBe("function");
});

// -- Identity stability --

test("observable edge navigation returns same wrapper on repeated access", () => {
  const client = makeClient();
  const obs = toObservable(client.root);
  expect(obs.items).toBe(obs.items);
});

// -- Symbol.observable --

test("Symbol.for('observable') returns self", () => {
  const client = makeClient();
  const obs = toObservable(client.root);
  const fn = obs[Symbol.observable];
  expect(typeof fn).toBe("function");
  expect(fn()).toBe(obs);
});

// -- RxJS-style observer object --

test("subscribe accepts an observer object with next()", () => {
  const client = makeClient();
  const obs = toObservable(client.root);
  let receivedValue: unknown;
  obs.subscribe({
    next(value) {
      receivedValue = value;
    },
  });
  expect(receivedValue).toBe(obs);
});

test("Symbol.observable interop with RxJS-style subscribe", () => {
  const client = makeClient();
  const obs = toObservable(client.root);
  const interop = obs[Symbol.observable]();
  let receivedValue: unknown;
  interop.subscribe({
    next(v: unknown) {
      receivedValue = v;
    },
  });
  expect(receivedValue).toBe(obs);
});

// -- Reflective operations on observable proxies --

test("ownKeys/spread work on observable stubs", () => {
  const client = makeClient();
  const obs = toObservable(client.root);
  // The raw stub has no own keys, and neither should the observable
  expect(() => Object.keys(obs)).not.toThrow();
});

// -- Raw stubs no longer intercept "subscribe" --

test("raw stub treats 'subscribe' as an edge name", () => {
  const client = makeClient();
  const raw = client.root;
  // On a raw stub, .subscribe should be an edge accessor (callable),
  // not a store subscription function. Edge accessors accept args and
  // return stubs. A store subscribe function would call the arg and
  // return an unsubscribe function.
  const sub = (raw as unknown as { subscribe: Function }).subscribe;
  // Edge accessor: calling with a non-function arg should return a stub
  const child: unknown = sub("topic");
  expect((child as { [STUB_PATH]?: unknown })[STUB_PATH]).toBeTruthy();
});
