/**
 * RpcStub<T> — Compile-time mapped type that transforms server API classes
 * into their client-side proxy equivalents.
 *
 * In an ideal world, we'd be able to, in the type system, examine which
 * functions had which decorators (e.g., using branded types). But decorators
 * are not allowed to change types, making this impossible for now. In place of
 * that, we use the following heuristics:
 * - Getters/methods returning Node (sync or async) → @edge → synchronous stub navigation
 * - Methods returning T or Promise<T> (non-Node) → @method → keeps as Promise<T>
 * - Methods returning AsyncGenerator<T> → @stream → returns RpcStream<T>
 * - await on a stub → fetches data, returns data props + stubs
 */

import type { OperationInfo, OperationResult, RateLimitInfo } from "./hooks";
import type { Transport } from "./protocol";
import type { Reference } from "./ref";
import type { PathArg } from "./path-arg";
import type { SerializerOptions } from "./serialization";

// -- Timer abstraction --

export interface Timers {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
}

export function defaultTimers(): Timers {
  return {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
}

declare global {
  interface SymbolConstructor {
    readonly observable: symbol;
  }
}

// -- Node base class --

export declare const nodeTag: unique symbol;
export declare const pathTag: unique symbol;

export abstract class Node {
  declare readonly [nodeTag]: true;
}

// -- canonicalPath symbol --

export const canonicalPath: unique symbol = Symbol("graphpc.canonicalPath");

/** Extract the args tuple from a class's static [canonicalPath] method (excluding the root param). */
export type CanonicalArgs<T> = typeof canonicalPath extends keyof T
  ? T[typeof canonicalPath] extends (root: any, ...args: infer A) => any
    ? A
    : never
  : never;

// -- Register / Context --

/** Augment via `declare module "graphpc" { interface Register { context: ... } }` */
export interface Register {}

/** Resolved context type — inferred from Register if augmented, otherwise {}. */
export type Context = Register extends { context: infer C } ? C : {};

// -- ClientOptions --

export interface ReconnectOptions {
  initialDelay?: number; // default 1000ms
  maxDelay?: number; // default 30000ms
  multiplier?: number; // default 2
  maxRetries?: number; // default 5
}

export interface LoopProtectionOptions {
  bucketSize?: number; // max burst of subscriber notifications per path (default: 20)
  refillRate?: number; // tokens refilled per second per path (default: 3)
}

export interface ClientOptions extends SerializerOptions {
  hydrationTimeout?: number;
  reconnect?: boolean | ReconnectOptions;
  loopProtection?: boolean | LoopProtectionOptions;
  timers?: Timers;
}

// -- Server event types --

export interface OperationErrorInfo {
  error: unknown;
  errorId: string;
  redacted: boolean;
}

export type ServerEventMap = {
  error: (err: unknown) => void;
  operationError: (ctx: Context, info: OperationErrorInfo) => void;
  connection: (ctx: Context) => void;
  disconnect: (ctx: Context) => void;
  operation: (
    ctx: Context,
    info: OperationInfo,
    execute: () => Promise<OperationResult>,
  ) => Promise<OperationResult>;
  rateLimit: (ctx: Context, info: RateLimitInfo) => void;
};

export type ServerEvent = keyof ServerEventMap;

// -- Bun-style WebSocket handler types --

/** Duck-typed Bun ServerWebSocket. Does not require Bun at import time. */
export interface WsLike<T> {
  readonly data: T;
  send(data: string): number | void;
  close(code?: number, reason?: string): void;
}

/** Lifecycle handlers returned by `server.wsHandlers()` for Bun's handler-based WebSocket API. */
export interface WebSocketHandlers<T> {
  /** Runtime dummy — Bun uses this for typing ws.data. Actual value comes from upgrade(). */
  data: T;
  open(ws: WsLike<T>): void;
  message(ws: WsLike<T>, message: string | ArrayBuffer | Uint8Array): void;
  close(ws: WsLike<T>, code?: number, reason?: string): void;
  error(ws: WsLike<T>, error: unknown): void;
}

// -- ServerInstance phantom type --

export interface ServerInstance<TRoot extends object> {
  /** Handle a new connection using a Transport (Web WebSocket, ws, or mock). */
  handle(transport: Transport, ctx: Context): void;
  /** Get Bun-style WebSocket lifecycle handlers. */
  wsHandlers<T>(getContext: (data: T) => Context): WebSocketHandlers<T>;
  /** Subscribe to server events. */
  on<E extends ServerEvent>(event: E, handler: ServerEventMap[E]): void;
  /** Unsubscribe from server events. */
  off<E extends ServerEvent>(event: E, handler: ServerEventMap[E]): void;
  /** Gracefully shut down: reject new connections, abort existing ones, force-close after grace period. */
  close(opts?: { gracePeriod?: number }): Promise<void>;
  /** Phantom — use `RootOf<typeof server>` to extract. */
  readonly Root: TRoot;
}

export type RootOf<S> = S extends ServerInstance<infer R> ? R : never;

// -- RpcStream type --

/** Client-side stream handle. Async iterable + lifecycle controls. */
export interface RpcStream<T> {
  /** Async iteration support. */
  [Symbol.asyncIterator](): AsyncIterator<T>;
  /** Set to opt in to auto-resume on reconnect. Called to get a new stream. */
  resume?: () => RpcStream<T>;
  /** Cancel the stream. */
  cancel(): void;
}

// -- RpcStub types --

/** Check if T extends Node */
type IsNode<T> = T extends Node ? true : false;

/** Detect Path<T> via phantom brand */
type IsPath<T> = T extends { readonly [pathTag]: any } ? true : false;

/** Map Path<T> params → PathArg on the client */
type MapPathParam<T> = T extends { readonly [pathTag]: any } ? PathArg : T;
type MapPathParams<T extends any[]> = { [K in keyof T]: MapPathParam<T[K]> };

/** Strip leading AbortSignal from parameter tuple */
type StripAbortSignal<T extends any[]> = T extends [AbortSignal, ...infer Rest]
  ? Rest
  : T;

/** Unwrap Reference<T> or Path<T> to transparent data+stub hybrid / stub */
type UnwrapRef<T> =
  T extends Reference<infer U>
    ? RpcDataOf<U> & RpcNav<U>
    : T extends { readonly [pathTag]: infer U }
      ? U extends Node
        ? RpcStub<U>
        : T
      : T;

/** Recursively unwrap references in a type */
type UnwrapReferences<T> =
  T extends Reference<infer U>
    ? RpcDataOf<U> & RpcNav<U>
    : T extends Array<infer E>
      ? UnwrapRef<E>[]
      : T extends Map<infer K, infer V>
        ? Map<K, UnwrapRef<V>>
        : T extends Set<infer E>
          ? Set<UnwrapRef<E>>
          : T extends object
            ? { [K in keyof T]: UnwrapRef<T[K]> }
            : T;

/** Detect object properties whose values are Node subclasses (for ShallowContainsNode) */
type HasNodeValue<T> = {
  [K in keyof T]: T[K] extends Reference<any>
    ? never
    : IsPath<T[K]> extends true
      ? never
      : IsNode<T[K]> extends true
        ? K
        : never;
}[keyof T];

/** Error type for methods that return bare Nodes inside containers */
type ShallowNodeError<
  Msg extends string =
    "Method returns a bare Node inside a container. Wrap with Reference<T> to pass by reference.",
> = { readonly __error: Msg };

/**
 * Shallow check: does T contain a bare Node (not wrapped in Reference)?
 * Covers: arrays, Maps, Sets, and one-level-deep object properties.
 */
type ShallowContainsNode<T> =
  T extends Reference<any>
    ? false
    : IsPath<T> extends true
      ? false
      : IsNode<T> extends true
        ? true
        : T extends ReadonlyArray<infer E>
          ? E extends Reference<any>
            ? false
            : IsPath<E> extends true
              ? false
              : IsNode<E>
          : T extends Map<any, infer V>
            ? V extends Reference<any>
              ? false
              : IsPath<V> extends true
                ? false
                : IsNode<V>
            : T extends Set<infer E>
              ? E extends Reference<any>
                ? false
                : IsPath<E> extends true
                  ? false
                  : IsNode<E>
              : T extends object
                ? HasNodeValue<T> extends never
                  ? false
                  : true
                : false;

/** Resolve the return type of a method — rejects bare Nodes in containers, otherwise unwraps references */
type ResolveMethodReturn<A extends any[], R> =
  ShallowContainsNode<R> extends true
    ? (...args: A) => ShallowNodeError
    : (...args: A) => Promise<UnwrapReferences<R>>;

/** Extract plain data properties (non-function, non-Node, excluding nodeTag) */
export type RpcDataOf<T> = {
  readonly [K in keyof T as K extends typeof nodeTag
    ? never
    : T[K] extends Function
      ? never
      : IsNode<T[K]> extends true
        ? never
        : K]: T[K];
};

/** Detect if a function returns an AsyncGenerator */
type IsAsyncGenerator<T> =
  T extends AsyncGenerator<any, any, any> ? true : false;

/** Navigable parts of a stub — edges (sync/async returning Node), methods, streams, property edges */
type RpcNav<T> = {
  // Functions
  [K in keyof T as T[K] extends Function ? K : never]: T[K] extends (
    // Check for async generator (stream) first
    ...args: infer A
  ) => infer R
    ? IsAsyncGenerator<R> extends true
      ? R extends AsyncGenerator<infer Y, any, any>
        ? (
            ...args: MapPathParams<StripAbortSignal<A>>
          ) => RpcStream<UnwrapReferences<Y>>
        : never
      : // sync edge: (...args) => Node
        IsNode<R> extends true
        ? (...args: MapPathParams<A>) => RpcStub<R>
        : // async edge: (...args) => Promise<Node>
          R extends Promise<infer U>
          ? IsNode<U> extends true
            ? (...args: MapPathParams<A>) => RpcStub<U>
            : // method: (...args) => Promise<T> where T is not Node
              ResolveMethodReturn<MapPathParams<A>, U>
          : // sync method: (...args) => T where T is not Node
            ResolveMethodReturn<MapPathParams<A>, R>
    : never;
} & {
  // Property edges: non-function properties whose type extends Node
  [K in keyof T as T[K] extends Function
    ? never
    : IsNode<T[K]> extends true
      ? K
      : never]: RpcStub<T[K]>;
};

/** The stub type for a server class T */
export type RpcStub<T> = RpcNav<T> & PromiseLike<RpcDataOf<T> & RpcNav<T>>;

type RpcObservableSubscription<T> = {
  subscribe(
    callbackOrObserver:
      | ((value: RpcObservable<T>) => void)
      | { next?: (value: RpcObservable<T>) => void },
  ): (() => void) & { unsubscribe(): void };
  [Symbol.observable](): RpcObservable<T>;
};

type RpcObservableNav<T> = {
  [K in keyof T as T[K] extends Function ? K : never]: T[K] extends (
    ...args: infer A
  ) => infer R
    ? IsAsyncGenerator<R> extends true
      ? R extends AsyncGenerator<infer Y, any, any>
        ? (
            ...args: MapPathParams<StripAbortSignal<A>>
          ) => RpcStream<UnwrapReferences<Y>>
        : never
      : IsNode<R> extends true
        ? (...args: MapPathParams<A>) => RpcObservable<R>
        : R extends Promise<infer U>
          ? IsNode<U> extends true
            ? (...args: MapPathParams<A>) => RpcObservable<U>
            : ResolveMethodReturn<MapPathParams<A>, U>
          : ResolveMethodReturn<MapPathParams<A>, R>
    : never;
} & {
  [K in keyof T as T[K] extends Function
    ? never
    : IsNode<T[K]> extends true
      ? K
      : never]: RpcObservable<T[K]>;
};

type RpcObservableResolved<T> = RpcDataOf<T> &
  RpcObservableNav<T> &
  RpcObservableSubscription<T>;

/** Observable wrapper around an RpcStub. Adds .subscribe() and Symbol.observable. */
export type RpcObservable<T> = RpcObservableNav<T> &
  PromiseLike<RpcObservableResolved<T>> &
  RpcObservableSubscription<T>;

// -- Client event types --

export type ClientEventMap = {
  disconnect: () => void;
  reconnect: () => void;
  reconnectFailed: () => void;
};

export type ClientEvent = keyof ClientEventMap;

// -- RpcClient wrapper --

export interface RpcClient<S extends ServerInstance<any>> {
  readonly root: RpcStub<RootOf<S>>;
  /** Resolves once the client has received the hello message and is ready to issue operations. */
  readonly ready: Promise<void>;
  on<E extends ClientEvent>(event: E, handler: ClientEventMap[E]): void;
  off<E extends ClientEvent>(event: E, handler: ClientEventMap[E]): void;
  /** Hydrate from a pre-parsed value (e.g. window.__rpc from a <script> tag). Must be called before any awaits. */
  hydrate(value: unknown): void;
  /** Hydrate from a raw string (e.g. from fetch or localStorage). Must be called before any awaits. */
  hydrateString(str: string): void;
  /** Explicitly end hydration, dropping the cache. Method call results are discarded; all other data forms the starting point for the client cache. No-op if never hydrated. */
  endHydration(): void;
  /** Reset retry counter and immediately attempt to reconnect. No-op if connected, closed, or reconnect is disabled. */
  reconnect(): void;
  /** Cleanly shut down the client: close transport, cancel pending ops, stop reconnection. */
  close(): void;
}
