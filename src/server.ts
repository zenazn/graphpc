/**
 * Server-side handler: token machine + message dispatch.
 */

import { runWithSession, getNode, type CacheEntry } from "./context.ts";
import { RpcError } from "./errors.ts";
import { formatSegment } from "./format.ts";
import type { OperationResult } from "./hooks.ts";
import type { PathSegment } from "./path.ts";
import type {
  ClientMessage,
  DataResult,
  EdgeResult,
  GetResult,
  ServerMessage,
  Transport,
} from "./protocol.ts";
import { eventDataToString, parseClientMessage } from "./protocol.ts";
import { resolveData, resolveEdge, resolveGet } from "./resolve.ts";
import { buildSchema } from "./schema.ts";
import { createSerializer, type SerializerOptions } from "./serialization.ts";
import {
  type Timers,
  defaultTimers,
  type Context,
  type OperationErrorInfo,
  type ServerEventMap,
  type ServerInstance,
  type WebSocketHandlers,
  type WsLike,
} from "./types.ts";

export interface ServerOptions extends SerializerOptions {
  idleTimeout?: number; // ms before closing idle connection
  maxTokens?: number; // max tokens (edge traversals) before closing connection
  maxPendingOps?: number; // max concurrent pending operations per connection
  maxQueuedOps?: number; // max queued operations before closing connection
  maxOperationTimeout?: number; // ms before aborting a single operation (0 = disabled)
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
    },
    wsHandlers<T>(getContext: (data: T) => Context): WebSocketHandlers<T> {
      type Callbacks = { _message: (raw: string) => void; _close: () => void };
      const wsMap = new WeakMap<object, Callbacks>();

      return {
        data: undefined as unknown as T,
        open(ws: WsLike<T>) {
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
              else if (type === "close") callbacks._close = () => listener({});
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
    const nodeCache = new Map<string, CacheEntry>();
    nodeCache.set("root", {
      promise: Promise.resolve(root),
      settled: true,
      resolve: () => Promise.resolve(root),
    });

    // Token → cache key. Computed synchronously when edge messages arrive,
    // so pipelined children can look up parent keys without awaiting.
    const tokens: string[] = ["root"];
    let tokenCount = 1;
    let shouldClose = false;
    const maxTokens = options.maxTokens ?? 9000;

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingOps = 0;
    const connAbort = new AbortController();
    const maxPendingOps = options.maxPendingOps ?? 20;
    const maxQueuedOps = options.maxQueuedOps ?? 1000;
    const maxOperationTimeout = options.maxOperationTimeout ?? 30_000;
    let activeOps = 0;
    const slotQueue: Array<{
      resolve: () => void;
      reject: (err: Error) => void;
    }> = [];

    // Build schema for this connection's context
    const { schema, classIndex } = buildSchema(
      root.constructor as new (...args: any[]) => any,
      ctx,
    );

    // Send hello message (message 0)
    const initMsg: ServerMessage = {
      op: "hello",
      version: 1,
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

    const idleTimeout = options.idleTimeout ?? 5_000;

    function resetIdleTimer() {
      if (idleTimer) timers.clearTimeout(idleTimer);
      if (idleTimeout > 0) {
        idleTimer = timers.setTimeout(() => {
          if (pendingOps === 0) {
            transport.close();
          }
        }, idleTimeout);
      }
    }

    resetIdleTimer();

    function acquireSlot(): Promise<void> {
      if (activeOps < maxPendingOps) {
        activeOps++;
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        slotQueue.push({
          resolve: () => {
            activeOps++;
            resolve();
          },
          reject,
        });
      });
    }

    function releaseSlot() {
      activeOps--;
      if (slotQueue.length > 0) slotQueue.shift()!.resolve();
    }

    /**
     * Resolve a token to a node object.
     * Token → cache key is synchronous; the cache entry resolves lazily.
     */
    function waitForToken(tok: number): Promise<object> {
      if (tok >= tokenCount) {
        throw new RpcError("INVALID_TOKEN", `Unknown token: ${tok}`);
      }
      const cacheKey = tokens[tok];
      if (!cacheKey) {
        throw new RpcError("INVALID_TOKEN", `Unknown token: ${tok}`);
      }
      const entry = nodeCache.get(cacheKey);
      if (!entry) {
        throw new RpcError("INVALID_TOKEN", `No cache entry for token ${tok}`);
      }
      return getNode(entry);
    }

    // Track auto-wrapped errors → original thrown value.
    // When a handler wraps a non-RpcError, non-custom error in an RpcError,
    // it stores the mapping here so processErrorResponse knows it can redact.
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

      // Determine the original error (before wrapping) for reporting
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
    ): Promise<EdgeResult> {
      await acquireSlot();
      try {
        const entry = nodeCache.get(tokens[claimToken]!)!;
        await getNode(entry);
        return { op: "edge", tok: claimToken, re };
      } catch (err) {
        if (err instanceof RpcError || serializer.handles(err)) {
          return { op: "edge", tok: claimToken, re, error: err };
        }
        const rpcErr = new RpcError("EDGE_ERROR", String(err));
        wrappedOriginals.set(rpcErr, err);
        return { op: "edge", tok: claimToken, re, error: rpcErr };
      } finally {
        releaseSlot();
      }
    }

    async function handleGet(
      msg: ClientMessage & { op: "get" },
      re: number,
    ): Promise<GetResult> {
      try {
        const node = await waitForToken(msg.tok);
        await acquireSlot();
        try {
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
    ): Promise<DataResult> {
      try {
        const node = await waitForToken(msg.tok);
        await acquireSlot();
        try {
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

    let nextClientMessageId = 1;

    transport.addEventListener("error", () => {}); // prevent crash with ws (EventEmitter)

    transport.addEventListener("message", (event) => {
      const raw = eventDataToString(event.data);
      const messageId = nextClientMessageId++;

      let msg: ClientMessage;
      try {
        msg = parseClientMessage(serializer.parse(raw));
      } catch (err) {
        emitError(err);
        transport.close();
        return;
      }

      pendingOps++;

      if (pendingOps > maxQueuedOps) {
        transport.close();
        return;
      }

      resetIdleTimer();

      const opAbort = new AbortController();
      const opSignal = AbortSignal.any([connAbort.signal, opAbort.signal]);

      // For edge ops: allocate token, compute cache key, and create cache
      // entry — all synchronously, before any async work.
      let claimToken = -1;
      if (msg.op === "edge") {
        claimToken = tokenCount++;

        // Token limit: respond synchronously and close.
        if (tokenCount > maxTokens) {
          shouldClose = true;
          pendingOps--;
          const error = new RpcError(
            "TOKEN_LIMIT_EXCEEDED",
            "Connection closed: token limit exceeded",
          );
          const response = {
            op: "edge" as const,
            tok: claimToken,
            re: messageId,
            error,
            errorId: undefined as string | undefined,
          };
          processErrorResponse(response);
          transport.send(serializer.stringify(response));
          transport.close();
          return;
        }

        // Compute cache key from parent's (already-known) key.
        const parentKey = tokens[msg.tok];
        if (parentKey !== undefined) {
          const seg: PathSegment =
            msg.args && msg.args.length > 0
              ? [msg.edge, ...msg.args]
              : msg.edge;
          const fullKey = parentKey + formatSegment(seg, options.reducers);
          tokens[claimToken] = fullKey;

          if (!nodeCache.has(fullKey)) {
            const pKey = parentKey;
            const edgeName = msg.edge;
            const edgeArgs = msg.args ?? [];
            nodeCache.set(fullKey, {
              promise: null,
              settled: false,
              resolve: () =>
                getNode(nodeCache.get(pKey)!)
                  .then((parent) =>
                    resolveEdge(parent, edgeName, edgeArgs, ctx),
                  )
                  .catch((err) => {
                    // Wrap non-RpcError so the cached rejection carries
                    // EDGE_ERROR regardless of which handler reads it.
                    if (err instanceof RpcError || serializer.handles(err))
                      throw err;
                    const rpcErr = new RpcError("EDGE_ERROR", String(err));
                    wrappedOriginals.set(rpcErr, err);
                    throw rpcErr;
                  }),
            });
          }
        }
        // If parentKey is undefined (invalid parent token), tokens[claimToken]
        // stays undefined. handleEdge will use the cache entry's lazy
        // resolution which will cascade to the parent's error.
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
            response = {
              op: "edge",
              tok: claimToken,
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
            const executeOp = async (): Promise<ServerMessage> => {
              switch (msg.op) {
                case "edge": {
                  const r = await handleEdge(messageId, claimToken);
                  if (shouldClose) transport.close();
                  return r;
                }
                case "get":
                  return handleGet(msg, messageId);
                case "data":
                  return handleData(msg, messageId);
                default: {
                  const _exhaustive: never = msg;
                  throw new Error(
                    `Unknown operation: ${(_exhaustive as any).op}`,
                  );
                }
              }
            };

            let response: ServerMessage;
            // Snapshot handlers at call time so mid-operation off() doesn't affect this chain
            const handlers =
              operationHandlers.length > 0
                ? operationHandlers.slice()
                : undefined;
            if (handlers) {
              // Compute path from tokens (synchronous, zero extra cost)
              let opPath: string;
              if (msg.op === "edge") {
                opPath = tokens[claimToken] ?? "root";
              } else {
                opPath = tokens[msg.tok] ?? "root";
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
              // Build middleware chain: first registered = outermost
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
              // Process error responses: attach errorId, redact, emit event
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
              const errResponse = {
                op: "get" as const,
                tok: 0,
                re: messageId,
                error: internalErr,
                errorId: undefined as string | undefined,
              };
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
      for (const handler of disconnectHandlers) {
        try {
          handler(ctx);
        } catch (e) {
          emitError(e);
        }
      }
      connAbort.abort();
      // Reject any ops waiting for a concurrency slot so no user code
      // runs after the connection is gone.
      const closedErr = new RpcError("CONNECTION_CLOSED", "Connection closed");
      for (const waiter of slotQueue) waiter.reject(closedErr);
      slotQueue.length = 0;
      tokens.length = 0;
      nodeCache.clear();
    });
  };
}
