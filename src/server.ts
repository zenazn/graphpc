/**
 * Server-side handler: token ring buffer, LRU node cache, stream dispatch.
 */

import {
  runWithSession,
  getNode,
  createCacheEntry,
  type CacheEntry,
} from "./context";
import {
  RpcError,
  TokenExpiredError,
  StreamLimitExceededError,
} from "./errors";
import { formatSegment } from "./format";
import type { OperationResult } from "./hooks";
import type { PathSegment } from "./path";
import type {
  ClientMessage,
  DataResult,
  EdgeResult,
  GetResult,
  ServerMessage,
  Transport,
} from "./protocol";
import { eventDataToString, parseClientMessage } from "./protocol";
import { resolveData, resolveEdge, resolveGet, resolveStream } from "./resolve";
import { buildSchema } from "./schema";
import { createSerializer, type SerializerOptions } from "./serialization";
import {
  type Timers,
  defaultTimers,
  type Context,
  type OperationErrorInfo,
  type ServerEventMap,
  type ServerInstance,
  type WebSocketHandlers,
  type WsLike,
} from "./types";

export interface ServerOptions extends SerializerOptions {
  tokenWindow?: number; // sliding window size (default: 10000)
  lruTTL?: number; // ms before unpinned nodes are evicted from LRU (default: 60000)
  idleTimeout?: number; // ms before closing idle connection (default: 60000)
  maxPendingOps?: number; // max concurrent pending operations per connection
  maxQueuedOps?: number; // max queued operations before closing connection
  maxOperationTimeout?: number; // ms before aborting a single operation (0 = disabled)
  maxStreams?: number; // max concurrent streams per client (default: 32)
  maxCredits?: number; // max credits per stream the server will honor (default: 256)
  redactErrors?: boolean; // redact unregistered errors (default: auto-detect from NODE_ENV)
  timers?: Timers;
}

/**
 * Create a server instance with a per-connection factory.
 * Each call to `handle()` invokes the factory with the connection's context
 * to produce a fresh root object for that connection.
 */
export function createServer<TRoot extends object>(
  options: ServerOptions,
  factory: (ctx: Context) => TRoot,
): ServerInstance<TRoot> {
  const errorHandlers = new Set<ServerEventMap["error"]>();
  const opErrorHandlers = new Set<ServerEventMap["operationError"]>();
  const connectionHandlers = new Set<ServerEventMap["connection"]>();
  const disconnectHandlers = new Set<ServerEventMap["disconnect"]>();
  const operationHandlers: Array<ServerEventMap["operation"]> = [];

  function emitError(err: unknown) {
    for (const handler of errorHandlers) handler(err);
  }

  function emitOperationError(ctx: Context, info: OperationErrorInfo) {
    for (const handler of opErrorHandlers) handler(ctx, info);
  }

  return {
    handle(transport: Transport, ctx: Context): void {
      try {
        const root = factory(ctx);
        const handler = createHandler(
          root,
          options,
          emitError,
          emitOperationError,
          connectionHandlers,
          disconnectHandlers,
          operationHandlers,
        );
        handler(transport, ctx);
      } catch (err) {
        emitError(err);
        try {
          transport.close();
        } catch (closeErr) {
          emitError(closeErr);
        }
      }
    },
    wsHandlers<T>(getContext: (data: T) => Context): WebSocketHandlers<T> {
      type Callbacks = { _message: (raw: string) => void; _close: () => void };
      const wsMap = new WeakMap<object, Callbacks>();

      return {
        data: undefined as unknown as T,
        open(ws: WsLike<T>) {
          try {
            const callbacks: Callbacks = {
              _message: () => {},
              _close: () => {},
            };
            wsMap.set(ws, callbacks);

            const transport: Transport = {
              send(data: string) {
                ws.send(data);
              },
              close() {
                ws.close();
              },
              addEventListener(type: string, listener: any) {
                if (type === "message")
                  callbacks._message = (raw: string) => listener({ data: raw });
                else if (type === "close")
                  callbacks._close = () => listener({});
                // 'error' is handled via the error handler below
              },
              removeEventListener() {},
            };

            const ctx = getContext(ws.data);
            const root = factory(ctx);
            const handler = createHandler(
              root,
              options,
              emitError,
              emitOperationError,
              connectionHandlers,
              disconnectHandlers,
              operationHandlers,
            );
            handler(transport, ctx);
          } catch (err) {
            emitError(err);
            wsMap.delete(ws);
            try {
              ws.close();
            } catch (closeErr) {
              emitError(closeErr);
            }
          }
        },
        message(ws: WsLike<T>, message: string | ArrayBuffer | Uint8Array) {
          const cb = wsMap.get(ws);
          if (cb) cb._message(eventDataToString(message));
        },
        close(ws: WsLike<T>) {
          const cb = wsMap.get(ws);
          if (cb) {
            cb._close();
            wsMap.delete(ws);
          }
        },
        error(_ws: WsLike<T>, error: unknown) {
          emitError(error);
        },
      };
    },
    on(event, handler) {
      if (event === "error") errorHandlers.add(handler as any);
      else if (event === "operationError") opErrorHandlers.add(handler as any);
      else if (event === "connection") connectionHandlers.add(handler as any);
      else if (event === "disconnect") disconnectHandlers.add(handler as any);
      else if (event === "operation") operationHandlers.push(handler as any);
    },
    off(event, handler) {
      if (event === "error") errorHandlers.delete(handler as any);
      else if (event === "operationError")
        opErrorHandlers.delete(handler as any);
      else if (event === "connection")
        connectionHandlers.delete(handler as any);
      else if (event === "disconnect")
        disconnectHandlers.delete(handler as any);
      else if (event === "operation") {
        const idx = operationHandlers.indexOf(handler as any);
        if (idx !== -1) operationHandlers.splice(idx, 1);
      }
    },
  } as ServerInstance<TRoot>;
}

// -- NodeEntry for the path index + LRU --

interface NodeEntry {
  path: string; // cache key
  node: object | null; // resolved domain object (null if not yet resolved)
  nodePromise: Promise<object> | null;
  resolve: () => Promise<object>;
  settled: boolean;
  parent: NodeEntry | null;
  children: Set<NodeEntry>;
  tokenRefCount: number;
  pinCount: number;
  lastAccess: number;
  // LRU doubly-linked list pointers
  lruPrev: NodeEntry | null;
  lruNext: NodeEntry | null;
  inLru: boolean;
  cacheVersion: number; // tracks sync with nodeCache version
  segments: PathSegment[]; // full path segments from root for reconstruction
}

function createHandler(
  root: object,
  options: ServerOptions = {},
  emitError: (err: unknown) => void = () => {},
  emitOperationError: (
    ctx: Context,
    info: OperationErrorInfo,
  ) => void = () => {},
  connectionHandlers: ReadonlySet<ServerEventMap["connection"]> = new Set(),
  disconnectHandlers: ReadonlySet<ServerEventMap["disconnect"]> = new Set(),
  operationHandlers: readonly ServerEventMap["operation"][] = [],
) {
  const serializer = createSerializer(options);

  const timers = options.timers ?? defaultTimers();

  const redactErrors =
    options.redactErrors !== undefined
      ? options.redactErrors
      : typeof process !== "undefined" &&
        process.env?.NODE_ENV === "production";

  return (transport: Transport, ctx: Context) => {
    const W = options.tokenWindow ?? 10_000;
    const lruTTL = options.lruTTL ?? 60_000;
    const maxStreams = options.maxStreams ?? 32;
    const maxCredits = options.maxCredits ?? 256;

    // -- Token ring buffer --
    // Slot index = tok % W. Each slot stores a path string (or null).
    const tokenRing: (string | null)[] = new Array(W).fill(null);
    tokenRing[0] = "root"; // root token occupies slot 0
    let tokenCount = 1; // total tokens allocated (token 0 = root, start at 1)

    // -- Path index --
    const pathIndex = new Map<string, NodeEntry>();

    // -- Path segments index (survives eviction, used for node reconstruction) --
    const pathSegmentsIndex = new Map<string, PathSegment[]>();
    pathSegmentsIndex.set("root", []);

    // -- LRU doubly-linked list --
    let lruHead: NodeEntry | null = null; // most recently accessed
    let lruTail: NodeEntry | null = null; // least recently accessed

    function lruRemove(entry: NodeEntry) {
      if (!entry.inLru) return;
      entry.inLru = false;
      if (entry.lruPrev) entry.lruPrev.lruNext = entry.lruNext;
      else lruHead = entry.lruNext;
      if (entry.lruNext) entry.lruNext.lruPrev = entry.lruPrev;
      else lruTail = entry.lruPrev;
      entry.lruPrev = null;
      entry.lruNext = null;
    }

    function lruMoveToHead(entry: NodeEntry) {
      if (entry.pinCount > 0) return; // pinned nodes stay out of LRU
      if (entry.path === "root") return; // root is permanent
      lruRemove(entry);
      entry.inLru = true;
      entry.lruNext = lruHead;
      entry.lruPrev = null;
      if (lruHead) lruHead.lruPrev = entry;
      lruHead = entry;
      if (!lruTail) lruTail = entry;
    }

    function evictSubtree(entry: NodeEntry) {
      // Recursively evict children first
      for (const child of entry.children) {
        evictSubtree(child);
      }
      // Detach from parent
      if (entry.parent) {
        entry.parent.children.delete(entry);
      }
      // Remove from LRU
      lruRemove(entry);
      // Remove from path index
      pathIndex.delete(entry.path);
      // Invalidate nodeCache so re-resolution re-walks from root
      const cacheEntry = nodeCache.get(entry.path);
      if (cacheEntry) {
        cacheEntry.promise = null;
        cacheEntry.settled = false;
        cacheEntry.version++;
      }
      // Clean up segments + nodeCache if no valid tokens reference this path.
      // Segments are only needed for re-resolution (valid token + evicted node).
      if (entry.tokenRefCount <= 0) {
        pathSegmentsIndex.delete(entry.path);
        nodeCache.delete(entry.path);
      }
    }

    // LRU timer
    let lruTimer: ReturnType<typeof setTimeout> | null = null;
    function resetLruTimer() {
      if (lruTimer) timers.clearTimeout(lruTimer);
      if (lruTTL > 0) {
        lruTimer = timers.setTimeout(fireLruEviction, lruTTL);
      }
    }

    function fireLruEviction() {
      const now = Date.now();
      let entry = lruTail;
      while (entry) {
        const prev = entry.lruPrev;
        if (entry.pinCount === 0 && now - entry.lastAccess > lruTTL) {
          evictSubtree(entry);
        }
        entry = prev;
      }
      resetLruTimer();
    }

    // -- Root entry (permanent) --
    const rootEntry: NodeEntry = {
      path: "root",
      node: root,
      nodePromise: Promise.resolve(root),
      resolve: () => Promise.resolve(root),
      settled: true,
      parent: null,
      children: new Set(),
      tokenRefCount: 0,
      pinCount: 0,
      lastAccess: Date.now(),
      lruPrev: null,
      lruNext: null,
      inLru: false,
      cacheVersion: 0,
      segments: [],
    };
    pathIndex.set("root", rootEntry);

    // -- Token states (for pipelining) --
    type TokenState = {
      ready: Promise<void>;
      settled: boolean;
      resolve: () => void;
      reject: (err: unknown) => void;
    };
    function createTokenState(): TokenState {
      let resolveReady!: () => void;
      let rejectReady!: (err: unknown) => void;
      const state: TokenState = {
        ready: new Promise<void>((resolve, reject) => {
          resolveReady = resolve;
          rejectReady = reject;
        }),
        settled: false,
        resolve: () => {
          if (state.settled) return;
          state.settled = true;
          resolveReady();
        },
        reject: (err: unknown) => {
          if (state.settled) return;
          state.settled = true;
          rejectReady(err);
        },
      };
      state.ready.catch(() => {});
      return state;
    }
    // Sparse array: only populated for tokens within the window
    const tokenStates = new Map<number, TokenState>();
    const rootTokenState = createTokenState();
    rootTokenState.resolve();
    tokenStates.set(0, rootTokenState);

    // Map from token → path key (for tokens in the window)
    const tokenPaths = new Map<number, string>();
    tokenPaths.set(0, "root");

    function allocateToken(path: string): number {
      const tok = tokenCount++;
      const slot = tok % W;

      // Expire old token that occupied this slot
      const oldPath = tokenRing[slot] ?? null;
      if (oldPath !== null) {
        const oldTok = tok - W;
        // Never expire token 0 (root is always valid)
        if (oldTok === 0) {
          // Root token was in this slot; it remains valid via isTokenValid special case
          // but we don't delete its state
        } else {
          tokenStates.delete(oldTok);
          tokenPaths.delete(oldTok);
        }
        const oldEntry = pathIndex.get(oldPath);
        if (oldEntry) {
          oldEntry.tokenRefCount--;
          if (
            oldEntry.tokenRefCount <= 0 &&
            oldEntry.pinCount === 0 &&
            oldEntry.path !== "root"
          ) {
            evictSubtree(oldEntry);
          }
        }
      }

      tokenRing[slot] = path;
      tokenPaths.set(tok, path);

      const entry = pathIndex.get(path);
      if (entry) {
        entry.tokenRefCount++;
        entry.lastAccess = Date.now();
        lruMoveToHead(entry);
      }

      return tok;
    }

    function isTokenValid(tok: number): boolean {
      if (tok === 0) return true; // root is always valid
      // Token is valid if it's within the window
      return tok >= tokenCount - W && tok < tokenCount;
    }

    function getPathForToken(tok: number): string | null {
      if (!isTokenValid(tok)) return null;
      return tokenPaths.get(tok) ?? null;
    }

    // Resolve a path from root, creating NodeEntry objects along the way
    function ensureEntry(
      path: string,
      parentPath: string,
      edgeName: string,
      edgeArgs: unknown[],
    ): NodeEntry {
      let entry = pathIndex.get(path);
      if (entry) return entry;

      const parentEntry = pathIndex.get(parentPath);
      if (!parentEntry) {
        throw new RpcError("INVALID_TOKEN", "Parent node not cached");
      }

      const seg: PathSegment =
        edgeArgs.length > 0 ? [edgeName, ...edgeArgs] : edgeName;
      entry = {
        path,
        node: null,
        nodePromise: null,
        resolve: async () => {
          const parent = await getEntryNode(parentEntry);
          return resolveEdge(parent, edgeName, edgeArgs, ctx);
        },
        settled: false,
        parent: parentEntry,
        children: new Set(),
        tokenRefCount: 0,
        pinCount: 0,
        lastAccess: Date.now(),
        lruPrev: null,
        lruNext: null,
        inLru: false,
        cacheVersion: 0,
        segments: [...(parentEntry.segments ?? []), seg],
      };

      parentEntry.children.add(entry);
      pathIndex.set(path, entry);
      return entry;
    }

    async function getEntryNode(entry: NodeEntry): Promise<object> {
      // Check if the nodeCache entry was invalidated (e.g., by ref())
      const cacheEntry = nodeCache.get(entry.path);
      if (cacheEntry && cacheEntry.version > entry.cacheVersion) {
        // nodeCache was invalidated since we last resolved — re-resolve
        entry.node = null;
        entry.nodePromise = null;
        entry.settled = false;
        entry.cacheVersion = cacheEntry.version;
      }
      if (entry.node && entry.settled) return entry.node;
      // If previously rejected (settled but node is null), clear and re-resolve
      if (entry.settled && !entry.node) {
        entry.nodePromise = null;
        entry.settled = false;
      }
      if (!entry.nodePromise) {
        // Prefer resolving through nodeCache if available (handles ref() invalidation)
        if (cacheEntry) {
          entry.nodePromise = getNode(cacheEntry);
        } else {
          entry.nodePromise = entry.resolve();
        }
        entry.nodePromise.then(
          (node) => {
            entry.node = node;
            entry.settled = true;
          },
          () => {
            entry.settled = true;
          },
        );
        entry.nodePromise.catch(() => {});
      }
      return entry.nodePromise;
    }

    /**
     * Resolve a token to a NodeEntry and its node object.
     * If the node was evicted (valid token, missing entry), re-resolve from the nodeCache.
     */
    async function waitForToken(
      tok: number,
    ): Promise<{ entry: NodeEntry; node: object }> {
      if (!isTokenValid(tok)) {
        if (tok >= 0 && tok < tokenCount) {
          throw new TokenExpiredError();
        }
        throw new RpcError("INVALID_TOKEN", `Unknown token: ${tok}`);
      }
      const tokenState = tokenStates.get(tok);
      if (!tokenState) {
        throw new RpcError("INVALID_TOKEN", `Unknown token: ${tok}`);
      }
      await tokenState.ready;
      const path = getPathForToken(tok);
      if (!path) {
        throw new RpcError("INVALID_TOKEN", `Unknown token: ${tok}`);
      }
      let entry = pathIndex.get(path);
      if (!entry) {
        // Token is valid but node was evicted (LRU). Rebuild the ancestor chain
        // from stored segments so parent-closure invariant is maintained.
        const segments = pathSegmentsIndex.get(path);
        if (!segments) {
          // Fall back to nodeCache if segments aren't available
          const cacheEntry = nodeCache.get(path);
          if (!cacheEntry) {
            throw new RpcError(
              "INVALID_TOKEN",
              `No cache entry for token ${tok}`,
            );
          }
          const node = await getNode(cacheEntry);
          entry = {
            path,
            node,
            nodePromise: Promise.resolve(node),
            resolve: () => Promise.resolve(node),
            settled: true,
            parent: rootEntry,
            children: new Set(),
            tokenRefCount: 1,
            pinCount: 0,
            lastAccess: Date.now(),
            lruPrev: null,
            lruNext: null,
            inLru: false,
            cacheVersion: cacheEntry.version,
            segments: [],
          };
          rootEntry.children.add(entry);
          pathIndex.set(path, entry);
          lruMoveToHead(entry);
          return { entry, node };
        }

        // Rebuild entry chain by ensuring all ancestors exist
        let currentEntry = rootEntry;
        let currentKey = "root";
        for (const seg of segments) {
          const segName = typeof seg === "string" ? seg : seg[0];
          const segArgs =
            typeof seg === "string" ? [] : (seg.slice(1) as unknown[]);
          currentKey = currentKey + formatSegment(seg, options.reducers);
          let nextEntry = pathIndex.get(currentKey);
          if (!nextEntry) {
            nextEntry = ensureEntry(
              currentKey,
              currentEntry.path,
              segName,
              segArgs,
            );
          }
          currentEntry = nextEntry;
        }
        entry = currentEntry;
        // Restore tokenRefCount: count valid tokens that reference this path
        let refCount = 0;
        for (const [, tp] of tokenPaths) {
          if (tp === path) refCount++;
        }
        entry.tokenRefCount = refCount;
        const node = await getEntryNode(entry);
        return { entry, node };
      }
      entry.lastAccess = Date.now();
      lruMoveToHead(entry);
      const node = await getEntryNode(entry);
      return { entry, node };
    }

    // -- Old-style nodeCache for compatibility with ref() / walkPath --
    const nodeCache = new Map<string, CacheEntry>();
    nodeCache.set(
      "root",
      createCacheEntry(() => Promise.resolve(root), root),
    );

    // -- Streams --
    let nextStreamId = -1;
    let activeStreamCount = 0;

    interface ActiveStream {
      sid: number;
      entry: NodeEntry;
      iterator: AsyncIterator<unknown>;
      credits: number;
      cancelled: boolean;
      abortController: AbortController;
      sending: boolean; // true while we're in the send loop
      path: string[]; // ancestor paths for pinning
    }

    const activeStreams = new Map<number, ActiveStream>();

    function pinPath(entry: NodeEntry) {
      let current: NodeEntry | null = entry;
      while (current) {
        current.pinCount++;
        if (current.inLru) lruRemove(current);
        current = current.parent;
      }
    }

    function unpinPath(entry: NodeEntry) {
      let current: NodeEntry | null = entry;
      while (current) {
        current.pinCount--;
        if (
          current.pinCount === 0 &&
          current.tokenRefCount > 0 &&
          current.path !== "root"
        ) {
          lruMoveToHead(current);
        }
        // If pinCount and tokenRefCount both hit 0, evict
        if (
          current.pinCount === 0 &&
          current.tokenRefCount <= 0 &&
          current.path !== "root"
        ) {
          const parent: NodeEntry | null = current.parent;
          evictSubtree(current);
          // Continue walking ancestors to finish decrementing pinCount
          current = parent;
          continue;
        }
        current = current.parent;
      }
    }

    // -- Connection state --
    let pendingOps = 0;
    const connAbort = new AbortController();
    const maxPendingOps = options.maxPendingOps ?? 20;
    const maxQueuedOps = options.maxQueuedOps ?? 1000;
    const maxOperationTimeout = options.maxOperationTimeout ?? 30_000;
    let activeOps = 0;
    const slotQueue: Array<{
      resolve: () => void;
      reject: (err: Error) => void;
      settled: boolean;
      cleanup: () => void;
    }> = [];

    // Build schema for this connection's context
    const { schema, classIndex } = buildSchema(
      root.constructor as new (...args: any[]) => any,
      ctx,
    );

    // Send hello message (message 0)
    const initMsg: ServerMessage = {
      op: "hello",
      version: 2,
      tokenWindow: W,
      maxStreams,
      schema,
    };
    transport.send(serializer.stringify(initMsg));

    for (const handler of connectionHandlers) {
      try {
        handler(ctx);
      } catch (e) {
        emitError(e);
      }
    }

    const idleTimeout = options.idleTimeout ?? 60_000;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    function resetIdleTimer() {
      if (idleTimer) timers.clearTimeout(idleTimer);
      if (idleTimeout > 0) {
        idleTimer = timers.setTimeout(() => {
          if (pendingOps === 0 && activeStreamCount === 0) {
            transport.close();
          }
        }, idleTimeout);
      }
    }

    resetIdleTimer();
    resetLruTimer();

    function operationAbortError(): RpcError {
      return connAbort.signal.aborted
        ? new RpcError("CONNECTION_CLOSED", "Connection closed")
        : new RpcError("OPERATION_TIMEOUT", "Operation timed out");
    }

    function acquireSlot(signal: AbortSignal): Promise<void> {
      if (signal.aborted) {
        return Promise.reject(operationAbortError());
      }
      if (activeOps < maxPendingOps) {
        activeOps++;
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const waiter = {
          settled: false,
          cleanup: () => {},
          resolve: () => {
            if (waiter.settled) return;
            waiter.settled = true;
            waiter.cleanup();
            activeOps++;
            resolve();
          },
          reject: (err: Error) => {
            if (waiter.settled) return;
            waiter.settled = true;
            waiter.cleanup();
            reject(err);
          },
        };

        const onAbort = () => {
          const idx = slotQueue.indexOf(waiter);
          if (idx !== -1) slotQueue.splice(idx, 1);
          waiter.reject(operationAbortError());
        };

        waiter.cleanup = () => {
          signal.removeEventListener("abort", onAbort);
        };

        signal.addEventListener("abort", onAbort, { once: true });
        slotQueue.push(waiter);

        // Handle aborts that race with listener registration.
        if (signal.aborted) onAbort();
      });
    }

    function releaseSlot() {
      activeOps--;
      while (slotQueue.length > 0) {
        const next = slotQueue.shift()!;
        if (next.settled) continue;
        next.resolve();
        return;
      }
    }

    // Track auto-wrapped errors → original thrown value.
    const wrappedOriginals = new WeakMap<object, unknown>();

    /**
     * Process an error response: attach errorId, apply redaction, emit event.
     * Mutates the response in place and returns it.
     */
    function processErrorResponse<
      T extends { error: unknown; errorId?: string },
    >(response: T): T {
      const errorId = crypto.randomUUID();
      response.errorId = errorId;

      const responseError = response.error;
      const isWrapped =
        responseError !== null &&
        typeof responseError === "object" &&
        wrappedOriginals.has(responseError);
      const originalError = isWrapped
        ? wrappedOriginals.get(responseError)
        : responseError;
      const shouldRedactThis = redactErrors && isWrapped;

      if (shouldRedactThis) {
        response.error = new RpcError(
          (responseError as RpcError).code ?? "INTERNAL_ERROR",
          "Internal server error",
        );
      }

      emitOperationError(ctx, {
        error: originalError,
        errorId,
        redacted: shouldRedactThis,
      });

      return response;
    }

    async function handleEdge(
      re: number,
      claimToken: number,
      opSignal: AbortSignal,
    ): Promise<EdgeResult> {
      await acquireSlot(opSignal);
      try {
        if (opSignal.aborted) {
          throw operationAbortError();
        }
        const path = tokenPaths.get(claimToken);
        if (!path) {
          throw new RpcError(
            "INVALID_TOKEN",
            "Invalid parent token for edge traversal",
          );
        }
        const entry = pathIndex.get(path);
        if (!entry) {
          throw new RpcError(
            "INVALID_TOKEN",
            "Invalid parent token for edge traversal",
          );
        }
        await getEntryNode(entry);
        const tokenState = tokenStates.get(claimToken);
        tokenState?.resolve();
        return { op: "edge", tok: claimToken, re };
      } catch (err) {
        if (err instanceof RpcError || serializer.handles(err)) {
          const tokenState = tokenStates.get(claimToken);
          tokenState?.reject(err);
          return { op: "edge", tok: claimToken, re, error: err };
        }
        const rpcErr = new RpcError("EDGE_ERROR", String(err));
        wrappedOriginals.set(rpcErr, err);
        const tokenState = tokenStates.get(claimToken);
        tokenState?.reject(rpcErr);
        return { op: "edge", tok: claimToken, re, error: rpcErr };
      } finally {
        releaseSlot();
      }
    }

    async function handleGet(
      msg: ClientMessage & { op: "get" },
      re: number,
      opSignal: AbortSignal,
    ): Promise<GetResult> {
      try {
        const { node } = await waitForToken(msg.tok);
        await acquireSlot(opSignal);
        try {
          if (opSignal.aborted) {
            throw operationAbortError();
          }
          const result = await resolveGet(node, msg.name, msg.args ?? [], ctx);
          return { op: "get", tok: msg.tok, re, data: result };
        } finally {
          releaseSlot();
        }
      } catch (err) {
        if (err instanceof RpcError || serializer.handles(err)) {
          return { op: "get", tok: msg.tok, re, error: err };
        }
        const rpcErr = new RpcError("GET_ERROR", String(err));
        wrappedOriginals.set(rpcErr, err);
        return { op: "get", tok: msg.tok, re, error: rpcErr };
      }
    }

    async function handleData(
      msg: ClientMessage & { op: "data" },
      re: number,
      opSignal: AbortSignal,
    ): Promise<DataResult> {
      try {
        const { node } = await waitForToken(msg.tok);
        await acquireSlot(opSignal);
        try {
          if (opSignal.aborted) {
            throw operationAbortError();
          }
          const data = resolveData(node, ctx);
          return { op: "data", tok: msg.tok, re, data };
        } finally {
          releaseSlot();
        }
      } catch (err) {
        if (err instanceof RpcError || serializer.handles(err)) {
          return { op: "data", tok: msg.tok, re, error: err };
        }
        const rpcErr = new RpcError("DATA_ERROR", String(err));
        wrappedOriginals.set(rpcErr, err);
        return { op: "data", tok: msg.tok, re, error: rpcErr };
      }
    }

    async function handleStreamStart(
      msg: ClientMessage & { op: "stream_start" },
      re: number,
      sid: number,
      opSignal: AbortSignal,
    ): Promise<void> {
      try {
        if (activeStreamCount >= maxStreams) {
          throw new StreamLimitExceededError();
        }

        const { entry, node } = await waitForToken(msg.tok);
        await acquireSlot(opSignal);
        let iterator: AsyncIterator<unknown>;
        try {
          if (opSignal.aborted) throw operationAbortError();
          const streamAbort = new AbortController();
          // Link to connection abort
          connAbort.signal.addEventListener(
            "abort",
            () => streamAbort.abort(),
            { once: true },
          );
          iterator = await resolveStream(
            node,
            msg.stream,
            msg.args ?? [],
            streamAbort.signal,
            ctx,
          );

          const stream: ActiveStream = {
            sid,
            entry,
            iterator,
            credits: Math.min(msg.credits, maxCredits),
            cancelled: false,
            abortController: streamAbort,
            sending: false,
            path: [],
          };
          // If the timeout already fired, don't start the stream
          if (opSignal.aborted) {
            streamAbort.abort();
            if (typeof iterator.return === "function") {
              iterator.return().catch(() => {});
            }
            throw operationAbortError();
          }

          activeStreams.set(sid, stream);
          activeStreamCount++;

          // Pin the path
          pinPath(entry);

          // Send success response
          transport.send(serializer.stringify({ op: "stream_start", sid, re }));

          // Start pumping
          pumpStream(stream).catch((err) => {
            if (!stream.cancelled) {
              emitError(err);
              cleanupStream(stream);
            }
          });
        } finally {
          releaseSlot();
        }
      } catch (err) {
        // If the timeout already sent a response, don't double-send
        if (opSignal.aborted) return;
        let error = err;
        if (!(err instanceof RpcError) && !serializer.handles(err)) {
          const rpcErr = new RpcError("STREAM_ERROR", String(err));
          wrappedOriginals.set(rpcErr, err);
          error = rpcErr;
        }
        const response = {
          op: "stream_start" as const,
          sid,
          re,
          error,
          errorId: undefined as string | undefined,
        };
        processErrorResponse(response);
        transport.send(serializer.stringify(response));
      }
    }

    async function pumpStream(stream: ActiveStream) {
      if (stream.sending || stream.cancelled) return;
      stream.sending = true;
      try {
        while (stream.credits > 0 && !stream.cancelled) {
          let result: IteratorResult<unknown>;
          try {
            result = await stream.iterator.next();
          } catch (err) {
            // Stream threw — send end with error
            let error = err;
            if (!(err instanceof RpcError) && !serializer.handles(err)) {
              const rpcErr = new RpcError("STREAM_ERROR", String(err));
              wrappedOriginals.set(rpcErr, err);
              error = rpcErr;
            }
            const response = {
              op: "stream_end" as const,
              sid: stream.sid,
              error,
              errorId: undefined as string | undefined,
            };
            processErrorResponse(response);
            transport.send(serializer.stringify(response));
            cleanupStream(stream);
            return;
          }

          if (result.done) {
            // Stream completed naturally
            transport.send(
              serializer.stringify({ op: "stream_end", sid: stream.sid }),
            );
            cleanupStream(stream);
            return;
          }

          // Send data frame
          stream.credits--;
          transport.send(
            serializer.stringify({
              op: "stream_data",
              sid: stream.sid,
              data: result.value,
            }),
          );
        }
      } finally {
        stream.sending = false;
      }
      // If credits exhausted but not cancelled, yield blocks naturally (pump resumes on credit grant)
    }

    function cleanupStream(stream: ActiveStream) {
      activeStreams.delete(stream.sid);
      activeStreamCount--;
      stream.cancelled = true;
      stream.abortController.abort();
      // Call return() on iterator for cleanup
      if (typeof stream.iterator.return === "function") {
        stream.iterator.return().catch(() => {});
      }
      // Unpin the path
      unpinPath(stream.entry);
      resetIdleTimer();
    }

    let nextClientMessageId = 1;

    transport.addEventListener("error", () => {}); // prevent crash with ws (EventEmitter)

    transport.addEventListener("message", (event) => {
      const raw = eventDataToString(event.data);

      let msg: ClientMessage;
      try {
        msg = parseClientMessage(serializer.parse(raw));
      } catch (err) {
        emitError(err);
        transport.close();
        return;
      }

      // Handle stream credit and cancel without pendingOps tracking
      // These are fire-and-forget — no messageId, no response.
      if (msg.op === "stream_credit") {
        const stream = activeStreams.get(msg.sid);
        if (stream && !stream.cancelled) {
          stream.credits = Math.min(stream.credits + msg.credits, maxCredits);
          pumpStream(stream).catch((err) => {
            if (!stream.cancelled) {
              emitError(err);
              cleanupStream(stream);
            }
          });
        }
        return;
      }

      if (msg.op === "stream_cancel") {
        const stream = activeStreams.get(msg.sid);
        if (stream) {
          cleanupStream(stream);
        }
        return;
      }

      // Only request/response messages get a messageId.
      const messageId = nextClientMessageId++;

      pendingOps++;

      if (pendingOps > maxQueuedOps) {
        transport.close();
        return;
      }

      resetIdleTimer();

      const opAbort = new AbortController();
      const opSignal = AbortSignal.any([connAbort.signal, opAbort.signal]);

      // Allocate IDs synchronously before any async work.
      let claimToken = -1;
      let claimStreamId = 0;
      if (msg.op === "stream_start") {
        claimStreamId = nextStreamId--;
      }
      if (msg.op === "edge") {
        // Compute cache key from parent's (already-known) key.
        const parentPath = getPathForToken(msg.tok);
        if (parentPath !== null) {
          const seg: PathSegment =
            msg.args && msg.args.length > 0
              ? [msg.edge, ...msg.args]
              : msg.edge;
          const fullKey = parentPath + formatSegment(seg, options.reducers);

          claimToken = allocateToken(fullKey);
          tokenStates.set(claimToken, createTokenState());

          // Ensure NodeEntry exists
          const edgeName = msg.edge;
          const edgeArgs = msg.args ?? [];
          const entry = ensureEntry(fullKey, parentPath, edgeName, edgeArgs);
          entry.tokenRefCount = Math.max(entry.tokenRefCount, 1); // allocateToken already incremented

          // Record segments for node reconstruction after eviction
          if (!pathSegmentsIndex.has(fullKey)) {
            const parentSegs = pathSegmentsIndex.get(parentPath) ?? [];
            pathSegmentsIndex.set(fullKey, [...parentSegs, seg]);
          }

          // Also maintain the old nodeCache for ref()/walkPath() compatibility
          if (!nodeCache.has(fullKey)) {
            const pKey = parentPath;
            nodeCache.set(
              fullKey,
              createCacheEntry(() =>
                getNode(nodeCache.get(pKey)!)
                  .then((parent) =>
                    resolveEdge(parent, edgeName, edgeArgs, ctx),
                  )
                  .catch((err) => {
                    if (err instanceof RpcError || serializer.handles(err))
                      throw err;
                    const rpcErr = new RpcError("EDGE_ERROR", String(err));
                    wrappedOriginals.set(rpcErr, err);
                    throw rpcErr;
                  }),
              ),
            );
          }
        } else {
          // Parent token invalid — allocate a poisoned token
          const poisonKey = `__invalid_${tokenCount}`;
          claimToken = allocateToken(poisonKey);
          tokenStates.set(claimToken, createTokenState());
        }
      }

      let responded = false;
      let opTimer: ReturnType<typeof setTimeout> | null = null;

      if (maxOperationTimeout > 0) {
        opTimer = timers.setTimeout(() => {
          if (responded) return;
          responded = true;
          opAbort.abort();
          const timeoutErr = new RpcError(
            "OPERATION_TIMEOUT",
            "Operation timed out",
          );
          let response: ServerMessage & { errorId?: string };
          if (msg.op === "edge") {
            const tokenState = tokenStates.get(claimToken);
            tokenState?.reject(timeoutErr);
            response = {
              op: "edge",
              tok: claimToken,
              re: messageId,
              error: timeoutErr,
            };
          } else if (msg.op === "stream_start") {
            response = {
              op: "stream_start",
              sid: claimStreamId,
              re: messageId,
              error: timeoutErr,
            };
          } else {
            response = {
              op: msg.op,
              tok: msg.tok,
              re: messageId,
              error: timeoutErr,
            } as ServerMessage & { errorId?: string };
          }
          processErrorResponse(
            response as { error: unknown; errorId?: string },
          );
          transport.send(serializer.stringify(response));
        }, maxOperationTimeout);
      }

      runWithSession(
        {
          ctx,
          root,
          nodeCache,
          close: () => transport.close(),
          reducers: options.reducers,
          signal: opSignal,
          schema,
          classIndex,
        },
        async () => {
          try {
            if (msg.op === "stream_start") {
              if (!responded) {
                const handlers =
                  operationHandlers.length > 0
                    ? operationHandlers.slice()
                    : undefined;
                if (handlers) {
                  const opPath = getPathForToken(msg.tok) ?? "root";
                  const info = {
                    op: "stream_start" as const,
                    name: msg.stream,
                    path: opPath,
                    args: msg.args ?? [],
                    signal: opSignal,
                    messageId,
                  };
                  let execute: () => Promise<OperationResult> = async () => {
                    await handleStreamStart(
                      msg,
                      messageId,
                      claimStreamId,
                      opSignal,
                    );
                    return {};
                  };
                  for (let i = handlers.length - 1; i >= 0; i--) {
                    const handler = handlers[i]!;
                    const next = execute;
                    execute = () => handler(ctx, info, next);
                  }
                  await execute();
                } else {
                  await handleStreamStart(
                    msg,
                    messageId,
                    claimStreamId,
                    opSignal,
                  );
                }
                responded = true;
                if (opTimer) timers.clearTimeout(opTimer);
              }
              return;
            }

            const executeOp = async (): Promise<ServerMessage> => {
              switch (msg.op) {
                case "edge":
                  return handleEdge(messageId, claimToken, opSignal);
                case "get":
                  return handleGet(msg, messageId, opSignal);
                case "data":
                  return handleData(msg, messageId, opSignal);
                default: {
                  const _exhaustive: never = msg;
                  throw new Error(
                    `Unknown operation: ${(_exhaustive as any).op}`,
                  );
                }
              }
            };

            let response: ServerMessage;
            const handlers =
              operationHandlers.length > 0
                ? operationHandlers.slice()
                : undefined;
            if (handlers) {
              let opPath: string;
              if (msg.op === "edge") {
                opPath = tokenPaths.get(claimToken) ?? "root";
              } else {
                opPath = getPathForToken(msg.tok) ?? "root";
              }

              const info = {
                op: msg.op,
                name:
                  msg.op === "edge"
                    ? msg.edge
                    : msg.op === "get"
                      ? msg.name
                      : "data",
                path: opPath,
                args: msg.op === "data" ? [] : (msg.args ?? []),
                signal: opSignal,
                messageId,
              } as const;

              let captured!: ServerMessage;
              let execute: () => Promise<OperationResult> = async () => {
                captured = await executeOp();
                return "error" in captured
                  ? { error: (captured as any).error }
                  : {};
              };
              for (let i = handlers.length - 1; i >= 0; i--) {
                const handler = handlers[i]!;
                const next = execute;
                execute = () => handler(ctx, info, next);
              }
              await execute();
              response = captured;
            } else {
              response = await executeOp();
            }

            if (!responded) {
              responded = true;
              if (opTimer) timers.clearTimeout(opTimer);
              if ("error" in response) {
                processErrorResponse(
                  response as { error: unknown; errorId?: string },
                );
              }
              transport.send(serializer.stringify(response));
            }
          } catch (err) {
            if (!responded) {
              responded = true;
              if (opTimer) timers.clearTimeout(opTimer);
              const internalErr = new RpcError("INTERNAL_ERROR", String(err));
              wrappedOriginals.set(internalErr, err);
              if (msg.op === "edge") {
                const tokenState = tokenStates.get(claimToken);
                tokenState?.reject(internalErr);
              }
              const errResponse =
                msg.op === "edge"
                  ? {
                      op: "edge" as const,
                      tok: claimToken,
                      re: messageId,
                      error: internalErr,
                      errorId: undefined as string | undefined,
                    }
                  : ({
                      op: msg.op,
                      tok: (msg as any).tok,
                      re: messageId,
                      error: internalErr,
                      errorId: undefined as string | undefined,
                    } as const);
              processErrorResponse(errResponse);
              transport.send(serializer.stringify(errResponse));
            }
          } finally {
            if (opTimer) timers.clearTimeout(opTimer);
            pendingOps--;
            resetIdleTimer();
          }
        },
      ).catch((err) => {
        emitError(err);
      });
    });

    transport.addEventListener("close", () => {
      if (idleTimer) timers.clearTimeout(idleTimer);
      if (lruTimer) timers.clearTimeout(lruTimer);

      // Clean up all active streams
      for (const stream of activeStreams.values()) {
        stream.cancelled = true;
        stream.abortController.abort();
        if (typeof stream.iterator.return === "function") {
          stream.iterator.return().catch(() => {});
        }
      }
      activeStreams.clear();
      activeStreamCount = 0;

      for (const handler of disconnectHandlers) {
        try {
          handler(ctx);
        } catch (e) {
          emitError(e);
        }
      }
      connAbort.abort();
      const closedErr = new RpcError("CONNECTION_CLOSED", "Connection closed");
      for (const waiter of slotQueue) waiter.reject(closedErr);
      slotQueue.length = 0;
      tokenStates.clear();
      tokenPaths.clear();
      pathIndex.clear();
      nodeCache.clear();
      pathSegmentsIndex.clear();
    });
  };
}
