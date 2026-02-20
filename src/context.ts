/**
 * Session-scoped AsyncLocalStorage.
 *
 * Each connection gets a Session containing context, root, and a node cache.
 * `getContext()` is the public API; `getSession()` is internal (used by `ref()`).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Schema } from "./protocol.ts";
import type { Context } from "./types.ts";

export interface CacheEntry {
  promise: Promise<object> | null;
  settled: boolean;
  resolve: () => Promise<object>;
}

/** Get or create the lazy node promise from a cache entry. */
export function getNode(entry: CacheEntry): Promise<object> {
  if (!entry.promise) {
    entry.promise = entry.resolve();
    entry.promise.catch(() => {});
    entry.promise.then(
      () => {
        entry.settled = true;
      },
      () => {
        entry.settled = true;
      },
    );
  }
  return entry.promise;
}

/**
 * Invalidate a cache entry. Resets the promise if it has settled so the
 * next `getNode` call re-resolves. No-op if the promise has never been
 * accessed or is still in-flight (in-flight invalidation is undefined
 * by spec; this implementation ignores it).
 */
export function invalidateEntry(entry: CacheEntry): void {
  if (!entry.promise || !entry.settled) return;
  entry.promise = null;
  entry.settled = false;
}

export interface Session {
  ctx: Context;
  root: object;
  nodeCache: Map<string, CacheEntry>;
  close: () => void;
  reducers?: Record<string, (value: unknown) => false | unknown[]>;
  signal: AbortSignal;
  schema?: Schema;
  classIndex?: Map<Function, number>;
}

const sessionStorage = new AsyncLocalStorage<Session>();

/**
 * Retrieve the current connection context.
 * Must be called during an active request (inside an edge getter, method, etc.).
 * Throws if called outside of a request.
 */
export function getContext(): Context {
  const session = sessionStorage.getStore();
  if (session === undefined) {
    throw new Error(
      "getContext() called outside of a request. It can only be used inside edge getters, methods, and other code executing during a GraphPC request.",
    );
  }
  return session.ctx;
}

/**
 * Retrieve the abort signal for the current operation.
 * The signal fires when the connection closes or the operation times out.
 * Pass to `fetch()`, database clients, etc. for cooperative cancellation.
 * Must be called during an active request (inside an edge getter, method, etc.).
 */
export function abortSignal(): AbortSignal {
  const session = sessionStorage.getStore();
  if (session === undefined) {
    throw new Error(
      "abortSignal() called outside of a request. It can only be used inside edge getters, methods, and other code executing during a GraphPC request.",
    );
  }
  return session.signal;
}

/**
 * Abort the current connection.
 * Immediately closes the transport, ending the session.
 * Must be called during an active request (inside an edge getter, method, etc.).
 * If the client has reconnect enabled, it will auto-reconnect with fresh context.
 */
export function abortThisConn(): void {
  const session = sessionStorage.getStore();
  if (session === undefined) {
    throw new Error(
      "abortThisConn() called outside of a request. It can only be used inside edge getters, methods, and other code executing during a GraphPC request.",
    );
  }
  session.close();
}

/** @internal — used by ref() to access the full session (root + cache). */
export function getSession(): Session {
  const session = sessionStorage.getStore();
  if (session === undefined) {
    throw new Error("getSession() called outside of a request.");
  }
  return session;
}

/** @internal — like getSession() but returns undefined outside a request. */
export function tryGetSession(): Session | undefined {
  return sessionStorage.getStore();
}

/** @internal — used by the server handler to set session for a request. */
export function runWithSession<T>(session: Session, fn: () => T): T {
  return sessionStorage.run(session, fn);
}
