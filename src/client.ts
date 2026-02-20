/**
 * Client-side proxy stubs.
 *
 * All navigation is synchronous and produces stubs holding a path.
 * At await time, the path is resolved using the schema to determine
 * which segments are edge traversals and which is a terminal call.
 * Tokens are assigned lazily when edge messages are actually sent.
 *
 * classifyPath is fully synchronous — the schema contains edge→targetIndex
 * mappings, so no network round-trip is needed to determine segment types.
 *
 * When hydrate() or hydrateString() is called after creation, the client
 * serves cached data/calls before the transport is ready. The cache
 * persists until endHydration() is called or an inactivity timeout fires.
 *
 * When reconnect is enabled, in-flight operations survive transport
 * disconnections. Pending operations are replayed on the new connection.
 */

import { eventDataToString, parseServerMessage } from "./protocol.ts";
import type {
  Transport,
  ClientMessage,
  ServerMessage,
  Schema,
  HelloMessage,
} from "./protocol.ts";
import {
  createSerializer,
  createClientSerializer,
  type Serializer,
} from "./serialization.ts";
import { RpcError, ConnectionLostError } from "./errors.ts";
import { setErrorUuid } from "./error-uuid.ts";
import type {
  RpcStub,
  ClientOptions,
  ReconnectOptions,
  ServerInstance,
  RootOf,
  RpcClient,
  ClientEvent,
  ClientEventMap,
} from "./types.ts";
import { formatPath } from "./format.ts";
import type { PathSegments, PathSegment } from "./path.ts";
import { createStub, createDataProxy, classifyPath } from "./proxy.ts";
import type { ProxyBackend } from "./proxy.ts";
import type { HydrationData } from "./ssr.ts";
import { HydrationCache, validateHydrationData } from "./hydration.ts";
import { ReconnectScheduler } from "./reconnect-scheduler.ts";

/** Internal sentinel — never exposed to callers. */
class ReconnectingError extends Error {}

interface PendingTerminal {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  path: PathSegments;
}

export function createClient<S extends ServerInstance<any>>(
  options: ClientOptions,
  transportFactory: () => Transport,
): RpcClient<S> {
  let serializer: Serializer = createSerializer(options);

  // --- Reconnect config (enabled by default; pass reconnect: false to disable) ---
  const reconnectConfig: ReconnectOptions | null =
    options.reconnect === false
      ? null
      : options.reconnect === true || !options.reconnect
        ? {}
        : options.reconnect;

  const scheduler = reconnectConfig
    ? new ReconnectScheduler({
        maxRetries: reconnectConfig.maxRetries ?? 5,
        initialDelay: reconnectConfig.initialDelay ?? 1000,
        maxDelay: reconnectConfig.maxDelay ?? 30000,
        multiplier: reconnectConfig.multiplier ?? 2,
      })
    : null;

  let schema: Schema = [];

  function pathKey(path: PathSegments): string {
    return formatPath(path, options.reducers);
  }

  const emptyPathKey = "root";

  // --- Hydration cache ---
  const hydrationCache = new HydrationCache({
    timeout: options.hydrationTimeout ?? 250,
    reducers: options.reducers,
  });

  // --- Connection-scoped state ---
  // transport is null until ensureConnected() is called (lazy connection).
  // All code paths that use transport are gated behind `ready`, which only
  // resolves after wireTransport() assigns it, so the ! assertions are safe.
  let transport: Transport | null = null;
  let nextToken = 1;
  let resolvedEdges = new Map<string, Promise<number>>();
  resolvedEdges.set(emptyPathKey, Promise.resolve(0));
  let nextMessageId = 1;
  let pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: any) => void }
  >();
  let liveDataCache = new Map<number, Record<string, unknown>>();
  let getCache = new Map<string, Promise<unknown>>();
  let dataLoadCache = new Map<number, Promise<unknown>>();
  let pathToTokenSync = new Map<string, number>();
  pathToTokenSync.set(emptyPathKey, 0);

  let ready: Promise<void>;
  let resolveReady: () => void;
  ready = new Promise<void>((r) => (resolveReady = r));

  // --- Event emitter ---
  const listeners: { [K in ClientEvent]: Set<() => void> } = {
    disconnect: new Set(),
    reconnect: new Set(),
    reconnectFailed: new Set(),
  };

  function on<E extends ClientEvent>(event: E, handler: ClientEventMap[E]) {
    listeners[event].add(handler);
  }

  function off<E extends ClientEvent>(event: E, handler: ClientEventMap[E]) {
    listeners[event].delete(handler);
  }

  function emit(event: ClientEvent) {
    for (const handler of listeners[event]) {
      handler();
    }
  }

  // --- Reconnect state ---
  let isReconnecting = false;
  let exhausted = false;

  // Pending terminals survive reconnection
  const pendingTerminals = new Set<PendingTerminal>();

  function clearConnectionState() {
    resolvedEdges = new Map<string, Promise<number>>();
    resolvedEdges.set(emptyPathKey, Promise.resolve(0));
    pending = new Map();
    nextMessageId = 1;
    nextToken = 1;
    liveDataCache = new Map();
    getCache = new Map();
    dataLoadCache = new Map();
    pathToTokenSync = new Map();
    pathToTokenSync.set(emptyPathKey, 0);
    ready = new Promise<void>((r) => (resolveReady = r));
  }

  function wireTransport(t: Transport) {
    transport = t;

    t.addEventListener("message", (event) => {
      if (transport !== t) return;
      const raw = eventDataToString(event.data);
      let msg: ServerMessage;
      try {
        msg = parseServerMessage(serializer.parse(raw));
      } catch {
        return;
      }
      if (msg.op === "hello") {
        schema = (msg as HelloMessage).schema;
        if (isReconnecting) {
          isReconnecting = false;
          exhausted = false;
          scheduler!.reset();
          emit("reconnect");
          resolveReady!();
          replayPendingTerminals();
        } else {
          resolveReady!();
        }
        return;
      }

      const handler = pending.get(msg.re);
      if (!handler) return;
      pending.delete(msg.re);

      if ("error" in msg) {
        const errorId = (msg as any).errorId as string | undefined;
        if (errorId) setErrorUuid(msg.error, errorId);
        handler.reject(msg.error);
      } else if (msg.op === "edge") {
        handler.resolve(msg);
      } else {
        handler.resolve(msg.data);
      }
    });

    t.addEventListener("error", () => {}); // prevent crash with ws (EventEmitter)

    t.addEventListener("close", () => {
      if (transport !== t) return;
      handleDisconnect();
    });
  }

  function handleDisconnect() {
    if (closed) return;
    if (reconnectConfig) {
      // Reject all pending wire operations with ReconnectingError
      // This triggers the swallow-and-keep-alive logic in issueOperation
      const sentinel = new ReconnectingError();
      for (const handler of pending.values()) {
        handler.reject(sentinel);
      }
      pending.clear();

      emit("disconnect");
      clearConnectionState();

      if (pendingTerminals.size > 0) {
        // Eager reconnect: in-flight operations need replay.
        // Keep old transport ref so stale microtasks harmlessly
        // drop messages on the closed transport instead of crashing.
        isReconnecting = true;
        scheduleReconnect();
      } else {
        // Lazy reconnect: no pending work, so don't reconnect now.
        // Null out transport so ensureConnected() opens a fresh
        // connection when the next operation arrives.
        transport = null;
      }
    } else {
      // No reconnect — reject everything permanently
      const err = new RpcError("CONNECTION_CLOSED", "Transport closed");
      for (const handler of pending.values()) {
        handler.reject(err);
      }
      pending.clear();
      for (const pt of pendingTerminals) {
        pt.reject(err);
      }
      pendingTerminals.clear();
    }
  }

  function scheduleReconnect() {
    const scheduled = scheduler!.schedule(attemptReconnect);
    if (!scheduled) {
      exhausted = true;
      emit("reconnectFailed");
      const err = new ConnectionLostError();
      for (const pt of pendingTerminals) {
        pt.reject(err);
      }
      pendingTerminals.clear();
    }
  }

  function attemptReconnect() {
    let newTransport: Transport;
    try {
      newTransport = transportFactory();
    } catch {
      // Factory threw — retry
      scheduleReconnect();
      return;
    }

    wireTransport(newTransport);
    // If onClose fires before schema arrives, handleDisconnect will
    // call scheduleReconnect again
  }

  function replayPendingTerminals() {
    const snapshot = [...pendingTerminals];
    pendingTerminals.clear();
    for (const pt of snapshot) {
      issueOperation(pt);
    }
  }

  function sendEdge(
    parentPath: PathSegments,
    seg: PathSegment,
  ): Promise<number> {
    const fullPath = [...parentPath, seg];
    const key = pathKey(fullPath);
    const existing = resolvedEdges.get(key);
    if (existing) return existing;

    // Token is assigned inside the .then() (not eagerly) so that parent
    // edges always get lower tokens than children — matching the server's
    // claim() order which follows message arrival order.
    const promise = resolveEdgePath(parentPath).then(async (parentToken) => {
      await ready;
      const token = nextToken++;
      pathToTokenSync.set(key, token);
      const msgId = nextMessageId++;
      const edgeName = typeof seg === "string" ? seg : seg[0];
      const args = typeof seg === "string" ? [] : (seg.slice(1) as unknown[]);

      const msg: ClientMessage = {
        op: "edge",
        tok: parentToken,
        edge: edgeName,
        ...(args.length > 0 && { args }),
      };
      transport!.send(serializer.stringify(msg));

      // Track server response for bookkeeping; errors are handled
      // via poisoned tokens in the terminal operation's response.
      pending.set(msgId, {
        resolve: () => {},
        reject: () => {},
      });

      return token;
    });

    resolvedEdges.set(key, promise);
    return promise;
  }

  function resolveEdgePath(path: PathSegments): Promise<number> {
    const key = pathKey(path);
    const existing = resolvedEdges.get(key);
    if (existing) return existing;

    if (path.length === 0) return Promise.resolve(0);

    const parentPath = path.slice(0, -1);
    const seg = path[path.length - 1]!;
    return sendEdge(parentPath, seg);
  }

  function issueOperation(pt: PendingTerminal) {
    const work = ready.then(async () => {
      const { edgePath, terminal } = classifyPath(pt.path, schema);
      const token = await resolveEdgePath(edgePath);

      if (terminal) {
        const lastSegment = pt.path[pt.path.length - 1];
        const isPropertyRead = typeof lastSegment === "string";

        if (isPropertyRead) {
          // 1. Check liveDataCache (from prior full node load or ref overwrite)
          const cached = liveDataCache.get(token);
          if (cached && terminal.name in cached) {
            return cached[terminal.name];
          }

          // 2. Check getCache (coalescing concurrent/sequential cold reads)
          const getCacheKey = `${token}:${terminal.name}`;
          const existing = getCache.get(getCacheKey);
          if (existing) return existing;

          // 3. Cache miss: send get, store promise in getCache
          const msgId = nextMessageId++;
          const msg: ClientMessage = {
            op: "get",
            tok: token,
            name: terminal.name,
          };
          transport!.send(serializer.stringify(msg));
          const promise = new Promise((resolve, reject) => {
            pending.set(msgId, { resolve, reject });
          });
          getCache.set(getCacheKey, promise);
          return promise;
        }

        // Method calls — always send independently, never coalesce
        const msgId = nextMessageId++;
        const msg: ClientMessage = {
          op: "get",
          tok: token,
          name: terminal.name,
          ...(terminal.args.length > 0 && { args: terminal.args }),
        };
        transport!.send(serializer.stringify(msg));
        return new Promise((resolve, reject) => {
          pending.set(msgId, { resolve, reject });
        });
      } else {
        // Check if liveDataCache already has data (e.g., from ref overwrite)
        const cached = liveDataCache.get(token);
        if (cached) return createDataProxy(backend, edgePath, cached);

        // Coalesce concurrent data loads for the same token
        const inflight = dataLoadCache.get(token);
        if (inflight) return inflight;

        const msgId = nextMessageId++;
        const msg: ClientMessage = { op: "data", tok: token };
        transport!.send(serializer.stringify(msg));
        const promise = new Promise((resolve, reject) => {
          pending.set(msgId, {
            resolve: (data: any) => {
              liveDataCache.set(token, data);
              resolve(createDataProxy(backend, edgePath, data));
            },
            reject,
          });
        });
        dataLoadCache.set(token, promise);
        return promise;
      }
    });

    work.then(
      (value) => {
        pendingTerminals.delete(pt);
        pt.resolve(value);
      },
      (err) => {
        if (err instanceof ReconnectingError) {
          // Swallow — pt stays in pendingTerminals for replay
          return;
        }
        pendingTerminals.delete(pt);
        pt.reject(err);
      },
    );
  }

  const backend: ProxyBackend = {
    resolve(path: PathSegments): Promise<unknown> {
      if (closed) {
        return Promise.reject(new RpcError("CLIENT_CLOSED", "Client closed"));
      }
      if (exhausted) {
        return Promise.reject(new ConnectionLostError());
      }
      // Try hydration cache before awaiting transport
      if (hydrationCache.isActive()) {
        const { edgePath, terminal } = classifyPath(path, schema);
        const edgePathKey = pathKey(edgePath);
        const result = hydrationCache.lookup(edgePathKey, terminal);

        if (result.hit) {
          if (terminal) {
            return Promise.resolve(result.value);
          } else {
            return Promise.resolve(
              createDataProxy(
                backend,
                edgePath,
                result.value as Record<string, unknown>,
              ),
            );
          }
        }
        // Cache miss — fall through to normal transport path
      }

      ensureConnected();
      return new Promise((resolve, reject) => {
        const pt: PendingTerminal = { resolve, reject, path };
        pendingTerminals.add(pt);
        issueOperation(pt);
      });
    },
  };

  // Override serializer to produce data proxies for references and paths at parse time
  serializer = createClientSerializer(
    options,
    (value) => {
      const [path, data] = value as [PathSegments, Record<string, unknown>];
      const refPathKey = pathKey(path);
      const refToken = pathToTokenSync.get(refPathKey);
      if (refToken !== undefined) {
        liveDataCache.set(refToken, data);
        const prefix = `${refToken}:`;
        for (const key of getCache.keys()) {
          if (key.startsWith(prefix)) getCache.delete(key);
        }
        dataLoadCache.delete(refToken);
      }
      // Evict cached descendant edges so subsequent traversals
      // re-resolve from the fresh node instead of reusing stale tokens.
      for (const [edgeKey, _] of resolvedEdges) {
        if (edgeKey !== refPathKey && edgeKey.startsWith(refPathKey)) {
          resolvedEdges.delete(edgeKey);
          const tok = pathToTokenSync.get(edgeKey);
          if (tok !== undefined) {
            pathToTokenSync.delete(edgeKey);
            liveDataCache.delete(tok);
            dataLoadCache.delete(tok);
            const tokPrefix = `${tok}:`;
            for (const key of getCache.keys()) {
              if (key.startsWith(tokPrefix)) getCache.delete(key);
            }
          }
        }
      }
      return createDataProxy(backend, path, data);
    },
    (value) => {
      const [segments] = value as [PathSegments];
      return createStub(backend, segments);
    },
  );

  function ensureConnected() {
    if (!transport && !closed) {
      wireTransport(transportFactory());
    }
  }

  function reconnect() {
    if (closed) return;
    if (!scheduler) return;
    if (!isReconnecting && !exhausted) return;

    exhausted = false;
    scheduler.cancel();
    scheduler.reset();

    const stale = transport;
    transport = null;
    clearConnectionState();
    isReconnecting = true;
    attemptReconnect();
    // Close stale transport AFTER new one is wired.
    // The staleness guard prevents its close handler from interfering.
    if (stale) stale.close();
  }

  let closed = false;

  function close() {
    if (closed) return;
    closed = true;

    // Stop reconnection
    scheduler?.cancel();

    // Drop hydration state (clears inactivity timer)
    hydrationCache.drop();

    // Reject all pending wire operations
    const err = new RpcError("CLIENT_CLOSED", "Client closed");
    for (const handler of pending.values()) {
      handler.reject(err);
    }
    pending.clear();

    // Reject all pending terminals
    for (const pt of pendingTerminals) {
      pt.reject(err);
    }
    pendingTerminals.clear();

    // Close transport if connected
    if (transport) transport.close();
  }

  const stub = createStub(backend, []);

  function activateHydration(parsed: HydrationData) {
    schema = hydrationCache.activate(parsed);
  }

  const client: RpcClient<S> = {
    root: stub as unknown as RpcStub<RootOf<S>>,
    get ready() {
      ensureConnected();
      return ready;
    },
    on,
    off,
    hydrate(value: unknown) {
      activateHydration(
        validateHydrationData(serializer.revive(value as number | unknown[])),
      );
    },
    hydrateString(str: string) {
      activateHydration(validateHydrationData(serializer.parse(str)));
    },
    endHydration() {
      hydrationCache.drop();
    },
    reconnect,
    close,
  };

  return client;
}
