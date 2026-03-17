/**
 * Observable stub wrapper.
 *
 * toObservable(stub) returns a proxy that adds:
 * - .subscribe(callback) — Svelte store contract + RxJS compatible
 * - Symbol.observable — TC39/RxJS interop
 *
 * Observable behavior propagates through navigation: child stubs
 * accessed from an observable are also observable. Use toStub() to
 * unwrap back to a raw stub (e.g., to access an edge named "subscribe").
 */

import { STUB_PATH, STUB_BACKEND } from "./proxy";
import type { PathSegments } from "./path";
import type { ProxyBackend } from "./proxy";
import type { RpcObservable, RpcStub } from "./types";

const OBSERVABLE_RAW: unique symbol = Symbol("graphpc.observableRaw");
const observableCache = new WeakMap<object, object>();

const symbolRegistry = Symbol as { observable?: symbol };
const symbolObservable = symbolRegistry.observable ?? Symbol.for("observable");
if (symbolRegistry.observable === undefined) {
  symbolRegistry.observable = symbolObservable;
}

function wrapValue(value: unknown): unknown {
  if (
    value == null ||
    (typeof value !== "object" && typeof value !== "function")
  )
    return value;
  try {
    if ((value as { [STUB_PATH]?: unknown })[STUB_PATH] !== undefined)
      return toObservable(value);
  } catch {
    return value;
  }
  return value;
}

export function toObservable<T>(raw: RpcStub<T>): RpcObservable<T>;
export function toObservable<T>(value: T): T;
export function toObservable(input: unknown): unknown {
  const raw: any = input; // single any — proxy internals need dynamic access
  if (raw == null || (typeof raw !== "object" && typeof raw !== "function"))
    return raw;

  // Already observable — return as-is
  if (raw[OBSERVABLE_RAW] !== undefined) return raw;

  // Not a stub — return as-is
  try {
    if (raw[STUB_PATH] === undefined) return raw;
  } catch {
    return raw;
  }

  const cached = observableCache.get(raw);
  if (cached) return cached;

  // Use a function target when raw is callable (edge accessors)
  const target = typeof raw === "function" ? function () {} : {};

  const observable: any = new Proxy(target, {
    get(_target, prop, receiver) {
      if (prop === OBSERVABLE_RAW) return raw;
      if (prop === STUB_PATH || prop === STUB_BACKEND) return raw[prop];

      if (prop === "subscribe") {
        const backend: ProxyBackend | undefined = raw[STUB_BACKEND];
        const path: PathSegments | undefined = raw[STUB_PATH];
        if (!backend?.subscribe || !path) {
          return (
            callbackOrObserver:
              | ((value: any) => void)
              | { next?: (value: any) => void },
          ) => {
            const cb =
              typeof callbackOrObserver === "function"
                ? callbackOrObserver
                : callbackOrObserver?.next?.bind(callbackOrObserver);
            cb?.(receiver);
            const fn: any = () => {};
            fn.unsubscribe = fn;
            return fn;
          };
        }
        return (
          callbackOrObserver:
            | ((value: any) => void)
            | { next?: (value: any) => void },
        ) => {
          const cb =
            typeof callbackOrObserver === "function"
              ? callbackOrObserver
              : callbackOrObserver?.next?.bind(callbackOrObserver);
          cb?.(receiver);
          const unsub = backend.subscribe!(path, () => cb?.(receiver));
          const fn: any = () => unsub();
          fn.unsubscribe = fn;
          return fn;
        };
      }

      if (prop === symbolObservable) return () => receiver;

      if (prop === "then") {
        const rawThen = raw.then;
        if (!rawThen) return undefined;
        return (
          onFulfilled?: (v: any) => any,
          onRejected?: (e: any) => any,
        ) => {
          return rawThen(
            onFulfilled ? (v: any) => onFulfilled(wrapValue(v)) : undefined,
            onRejected,
          );
        };
      }

      // Other symbols — pass through without wrapping
      if (typeof prop === "symbol") return raw[prop];

      // String properties — delegate and wrap
      return wrapValue(raw[prop]);
    },

    apply(_target, _thisArg, args) {
      return wrapValue(raw(...args));
    },

    ownKeys() {
      return Reflect.ownKeys(raw);
    },

    getOwnPropertyDescriptor(_target, prop) {
      return Reflect.getOwnPropertyDescriptor(raw, prop);
    },

    has(_target, prop) {
      return prop in raw;
    },
  });

  observableCache.set(raw, observable);
  return observable;
}

export function toStub<T>(observable: RpcObservable<T>): RpcStub<T>;
export function toStub<T>(value: T): T;
export function toStub(value: unknown): unknown {
  if (
    value == null ||
    (typeof value !== "object" && typeof value !== "function")
  )
    return value;
  const raw = (value as { [OBSERVABLE_RAW]?: unknown })[OBSERVABLE_RAW];
  return raw !== undefined ? raw : value;
}
