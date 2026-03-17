/**
 * Client-side proxy stubs.
 *
 * All navigation is synchronous and produces stubs holding a path.
 * At await time, the path is resolved using the schema to determine
 * which segments are edge traversals and which is a terminal call.
 * Tokens are assigned lazily when edge messages are actually sent.
 *
 * Key changes in v2:
 * - Persistent cache: the client keeps its cache across reconnects.
 *   Same nodes, same promises, same data objects — referential identity.
 * - Token window: the server advertises a token window. The client tracks
 *   each token's birth count and replays paths on TOKEN_EXPIRED.
 * - Invalidation: path-based invalidation marks cache entries stale and
 *   notifies subscribers.
 * - Reactivity: subscribe() satisfies the Svelte store contract.
 * - Streams: server-push via async iteration with credit-based backpressure.
 */

import { eventDataToString, parseServerMessage } from "./protocol";
import type {
  Transport,
  ClientMessage,
  ServerMessage,
  Schema,
  HelloMessage,
} from "./protocol";
import {
  createSerializer,
  createClientSerializer,
  type Serializer,
} from "./serialization";
import { RpcError, ConnectionLostError, TokenExpiredError } from "./errors";
import { setErrorUuid } from "./error-uuid";
import type {
  RpcStub,
  RpcStream,
  ClientOptions,
  ReconnectOptions,
  ServerInstance,
  RootOf,
  RpcClient,
  ClientEvent,
  ClientEventMap,
} from "./types";
import { defaultTimers } from "./types";
import { formatPath, isDescendantPathKey } from "./format";
import type { PathSegments, PathSegment } from "./path";
import {
  createStub,
  createDataProxy,
  classifyPath,
  STUB_PATH,
  STUB_BACKEND,
} from "./proxy";
import type { ProxyBackend } from "./proxy";
import type { HydrationData } from "./ssr";
import { HydrationCache, validateHydrationData } from "./hydration";
import { ReconnectScheduler } from "./reconnect-scheduler";

/** Internal sentinel — never exposed to callers. */
class ReconnectingError extends Error {}

interface PendingTerminal {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  path: PathSegments;
}

// WeakMaps keyed by ProxyBackend — every stub from the same client shares a backend
const backendInvalidators = new WeakMap<
  ProxyBackend,
  (path: PathSegments) => void
>();
const backendEvictors = new WeakMap<
  ProxyBackend,
  (path: PathSegments) => void
>();

function getBackend(stub: any): ProxyBackend | undefined {
  return stub?.[STUB_BACKEND];
}

/**
 * Invalidate a path in the client cache.
 * Marks all cache entries at that path and below as stale,
 * and notifies subscribers on the path, all descendants, and all ancestors up to root.
 */
export function invalidate(stub: any): void {
  const path: PathSegments | undefined = stub?.[STUB_PATH];
  if (!path) return;
  const backend = getBackend(stub);
  if (!backend) return;
  const fn = backendInvalidators.get(backend);
  if (fn) fn(path);
}

/**
 * Evict a path from the client cache.
 * Drops proxy instances, cached data, and subscriptions for the path and its entire subtree.
 */
export function evict(stub: any): void {
  const path: PathSegments | undefined = stub?.[STUB_PATH];
  if (!path) return;
  const backend = getBackend(stub);
  if (!backend) return;
  const fn = backendEvictors.get(backend);
  if (fn) fn(path);
}

/**
 * Subscribe to a path for reactivity.
 * Satisfies the Svelte store contract: calls callback synchronously with current value (the stub),
 * then again on invalidation. Returns an unsubscribe function.
 */
export function subscribe(
  stub: any,
  callback: (value: any) => void,
): () => void {
  const path: PathSegments | undefined = stub?.[STUB_PATH];
  if (!path) {
    callback(stub);
    return () => {};
  }
  const backend = getBackend(stub);
  if (!backend?.subscribe) {
    callback(stub);
    return () => {};
  }
  // Svelte store contract: synchronous initial call with the stub
  callback(stub);
  // Register for invalidation notifications — callback with the SAME stub
  return backend.subscribe(path, () => callback(stub));
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
    ? new ReconnectScheduler(
        {
          maxRetries: reconnectConfig.maxRetries ?? 5,
          initialDelay: reconnectConfig.initialDelay ?? 1000,
          maxDelay: reconnectConfig.maxDelay ?? 30000,
          multiplier: reconnectConfig.multiplier ?? 2,
        },
        options.timers,
      )
    : null;

  let schema: Schema = [];
  let tokenWindow = 10_000;

  function pathKey(path: PathSegments): string {
    return formatPath(path, options.reducers);
  }

  const emptyPathKey = "root";

  // --- Hydration cache ---
  const hydrationCache = new HydrationCache({
    timeout: options.hydrationTimeout ?? 250,
    reducers: options.reducers,
    onDrop: (data) => {
      // Seed persistent cache with hydration data
      for (const [key, value] of data) {
        if (!liveDataCache.has(key) && value && typeof value === "object") {
          liveDataCache.set(key, value as Record<string, unknown>);
        }
      }
    },
  });

  // --- Persistent cache (survives reconnects) ---
  // These caches are NEVER reset on reconnect — that's the key difference from v1.
  let liveDataCache = new Map<string, Record<string, unknown>>(); // pathKey → data
  let dataProxyCache = new Map<string, any>(); // pathKey → data proxy (referential identity)
  let getCache = new Map<string, Promise<unknown>>(); // pathKey:name → promise
  let dataLoadCache = new Map<string, Promise<unknown>>(); // pathKey → promise

  // --- Connection-scoped state (reset on reconnect) ---
  let transport: Transport | null = null;
  let nextToken = 1;
  let sendCount = 0; // monotonically increasing count of edge messages sent
  let resolvedEdges = new Map<string, Promise<number>>();
  resolvedEdges.set(emptyPathKey, Promise.resolve(0));
  let nextMessageId = 1;
  let pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: any) => void }
  >();
  let pathToTokenSync = new Map<string, number>();
  pathToTokenSync.set(emptyPathKey, 0);
  // Track token birth counts for window tracking
  let tokenBirthCount = new Map<number, number>(); // token → sendCount at creation
  tokenBirthCount.set(0, 0);

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

  // --- Reactivity ---
  // Subscribers per path key
  const pathSubscribers = new Map<string, Set<() => void>>();

  function notifyPath(key: string) {
    const subs = pathSubscribers.get(key);
    if (!subs) return;
    for (const cb of subs) {
      cb();
    }
  }

  function doInvalidate(path: PathSegments) {
    const key = pathKey(path);

    // 1. Mark cache entries stale at this path
    liveDataCache.delete(key);
    dataProxyCache.delete(key);
    // Clear property caches
    const prefix = key + ":";
    for (const k of getCache.keys()) {
      if (k.startsWith(prefix) || k === key) getCache.delete(k);
    }
    dataLoadCache.delete(key);

    // 2. Invalidate all descendants
    for (const k of liveDataCache.keys()) {
      if (isDescendantPathKey(key, k)) liveDataCache.delete(k);
    }
    for (const k of dataProxyCache.keys()) {
      if (isDescendantPathKey(key, k)) dataProxyCache.delete(k);
    }
    for (const k of getCache.keys()) {
      if (isDescendantPathKey(key, k)) getCache.delete(k);
    }
    for (const k of dataLoadCache.keys()) {
      if (isDescendantPathKey(key, k)) dataLoadCache.delete(k);
    }

    // 3. Evict cached descendant edges so subsequent traversals re-resolve
    for (const edgeKey of resolvedEdges.keys()) {
      if (isDescendantPathKey(key, edgeKey)) {
        resolvedEdges.delete(edgeKey);
        const tok = pathToTokenSync.get(edgeKey);
        if (tok !== undefined) {
          pathToTokenSync.delete(edgeKey);
          tokenBirthCount.delete(tok);
        }
      }
    }

    // 4. Notify: target, descendants, ancestors
    notifyPath(key);
    for (const subKey of pathSubscribers.keys()) {
      if (isDescendantPathKey(key, subKey)) {
        notifyPath(subKey);
      }
    }
    // Notify ancestors up to root
    const parts = path.slice();
    while (parts.length > 0) {
      parts.pop();
      notifyPath(pathKey(parts));
    }
  }

  function doEvict(path: PathSegments) {
    const key = pathKey(path);

    // Drop everything at this path and below
    liveDataCache.delete(key);
    dataProxyCache.delete(key);
    for (const k of liveDataCache.keys()) {
      if (isDescendantPathKey(key, k)) liveDataCache.delete(k);
    }
    for (const k of dataProxyCache.keys()) {
      if (isDescendantPathKey(key, k)) dataProxyCache.delete(k);
    }
    for (const k of getCache.keys()) {
      if (k.startsWith(key + ":") || k === key || isDescendantPathKey(key, k)) {
        getCache.delete(k);
      }
    }
    for (const k of dataLoadCache.keys()) {
      if (k === key || isDescendantPathKey(key, k)) dataLoadCache.delete(k);
    }
    for (const edgeKey of resolvedEdges.keys()) {
      if (edgeKey === key || isDescendantPathKey(key, edgeKey)) {
        resolvedEdges.delete(edgeKey);
        const tok = pathToTokenSync.get(edgeKey);
        if (tok !== undefined) {
          pathToTokenSync.delete(edgeKey);
          tokenBirthCount.delete(tok);
        }
      }
    }
    // Remove subscribers
    for (const subKey of pathSubscribers.keys()) {
      if (subKey === key || isDescendantPathKey(key, subKey)) {
        pathSubscribers.delete(subKey);
      }
    }
  }

  // --- Reconnect state ---
  let isReconnecting = false;
  let exhausted = false;

  // Pending terminals survive reconnection
  const pendingTerminals = new Set<PendingTerminal>();

  // Circuit breaker for TOKEN_EXPIRED replay storms
  const replayAttempts = new Map<string, number>();
  const MAX_REPLAYS = 5;

  function clearConnectionState() {
    resolvedEdges = new Map<string, Promise<number>>();
    resolvedEdges.set(emptyPathKey, Promise.resolve(0));
    pending = new Map();
    nextMessageId = 1;
    nextToken = 1;
    sendCount = 0;
    pathToTokenSync = new Map();
    pathToTokenSync.set(emptyPathKey, 0);
    tokenBirthCount = new Map();
    tokenBirthCount.set(0, 0);
    // NOTE: liveDataCache, getCache, dataLoadCache are NOT cleared — persistent cache
    ready = new Promise<void>((r) => (resolveReady = r));
  }

  // --- Streams ---
  const activeClientStreams = new Map<number, ClientStreamState>();
  // Map from stream_start message ID → streamState, for registering on response
  const pendingStreamStarts = new Map<number, ClientStreamState>();
  // Queue of old stream states awaiting rebinding during resume
  const resumeQueue: ClientStreamState[] = [];

  interface ClientStreamState {
    sid: number;
    windowSize: number;
    consumed: number;
    framesSinceGrant: number; // frames received since last credit grant
    lastGrantSize: number; // size of the most recent credit grant
    pending: {
      resolve: (v: IteratorResult<unknown>) => void;
      reject: (e: any) => void;
    } | null;
    buffer: unknown[];
    done: boolean;
    error: unknown | null;
    cancelled: boolean;
    resume?: () => RpcStream<unknown>;
    creditTimer: ReturnType<typeof setTimeout> | null;
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
        try {
          t.close();
        } catch {}
        return;
      }
      if (msg.op === "hello") {
        const hello = msg as HelloMessage;
        schema = hello.schema;
        tokenWindow = hello.tokenWindow;
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

      // Stream data
      if (msg.op === "stream_data") {
        const stream = activeClientStreams.get(msg.sid);
        if (!stream || stream.cancelled) return;
        stream.framesSinceGrant++;
        if (stream.pending) {
          const { resolve } = stream.pending;
          stream.pending = null;
          stream.consumed++; // consumed immediately — count it
          resolve({ value: msg.data, done: false });
          maybeGrantCredits(stream); // check after delivery
        } else {
          stream.buffer.push(msg.data); // buffered — don't count yet
        }
        return;
      }

      // Stream end
      if (msg.op === "stream_end") {
        const stream = activeClientStreams.get(msg.sid);
        if (!stream) return;
        stream.done = true;
        if (msg.error) {
          stream.error = msg.error;
          if (msg.errorId) setErrorUuid(msg.error, msg.errorId);
        }
        if (stream.pending) {
          const { resolve, reject } = stream.pending;
          stream.pending = null;
          if (stream.error) {
            reject(stream.error);
          } else {
            resolve({ value: undefined, done: true });
          }
        }
        activeClientStreams.delete(msg.sid);
        return;
      }

      // Stream start response
      if (msg.op === "stream_start") {
        const handler = pending.get(msg.re);
        if (!handler) return;
        pending.delete(msg.re);
        if ("error" in msg) {
          const errorId = (msg as any).errorId as string | undefined;
          if (errorId) setErrorUuid(msg.error, errorId);
          // Also fail the stream state
          const streamState = pendingStreamStarts.get(msg.re);
          if (streamState) {
            pendingStreamStarts.delete(msg.re);
            streamState.done = true;
            streamState.error = msg.error;
          }
          handler.reject(msg.error);
        } else {
          // Register the stream state immediately so stream_data can find it
          const streamState = pendingStreamStarts.get(msg.re);
          if (streamState) {
            pendingStreamStarts.delete(msg.re);
            streamState.sid = msg.sid;
            // If cancelled while waiting for stream_start, send cancel now
            if (streamState.cancelled) {
              if (transport) {
                try {
                  transport.send(
                    serializer.stringify({
                      op: "stream_cancel",
                      sid: msg.sid,
                    }),
                  );
                } catch {}
              }
            } else {
              activeClientStreams.set(msg.sid, streamState);
            }
          }
          handler.resolve(msg.sid);
        }
        return;
      }

      // Regular request/response
      if (!("re" in msg)) return;
      const handler = pending.get(msg.re as number);
      if (!handler) return;
      pending.delete(msg.re as number);

      if ("error" in msg) {
        const errorId = (msg as any).errorId as string | undefined;
        if (errorId) setErrorUuid(msg.error, errorId);
        handler.reject(msg.error);
      } else if (msg.op === "edge") {
        handler.resolve(msg);
      } else {
        handler.resolve((msg as any).data);
      }
    });

    t.addEventListener("error", () => {}); // prevent crash with ws (EventEmitter)

    t.addEventListener("close", () => {
      if (transport !== t) return;
      handleDisconnect();
    });
  }

  const MAX_CREDIT_WINDOW = 256;

  function maybeGrantCredits(stream: ClientStreamState) {
    if (stream.cancelled || stream.done) return;
    const threshold = Math.floor(stream.windowSize / 2);
    if (stream.consumed >= threshold) {
      const exhaustedWindow = stream.framesSinceGrant >= stream.lastGrantSize;
      if (exhaustedWindow && stream.windowSize < MAX_CREDIT_WINDOW) {
        stream.windowSize = Math.min(stream.windowSize * 2, MAX_CREDIT_WINDOW);
        grantCredits(stream, stream.windowSize);
      } else {
        grantCredits(stream);
      }
    } else if (stream.consumed > 0 && !stream.creditTimer) {
      // Timer-based grant
      const t = options.timers ?? defaultTimers();
      stream.creditTimer = t.setTimeout(() => {
        stream.creditTimer = null;
        if (!stream.cancelled && !stream.done && stream.consumed > 0) {
          grantCredits(stream);
        }
      }, 100);
    }
  }

  function grantCredits(stream: ClientStreamState, amount = stream.consumed) {
    if (!transport || stream.sid === 0 || stream.cancelled || stream.done)
      return;
    if (amount <= 0) return;
    const grant = amount;
    stream.consumed = 0;
    stream.framesSinceGrant = 0;
    stream.lastGrantSize = grant;
    transport.send(
      serializer.stringify({
        op: "stream_credit",
        sid: stream.sid,
        credits: grant,
      }),
    );
  }

  function handleDisconnect() {
    if (closed) return;

    // Handle active streams on disconnect
    for (const stream of activeClientStreams.values()) {
      // Clear any pending credit timer (it would fire on a closed transport)
      if (stream.creditTimer) {
        const t = options.timers ?? defaultTimers();
        t.clearTimeout(stream.creditTimer);
        stream.creditTimer = null;
      }
      if (stream.resume) {
        // With resume: pending next() blocks (doesn't resolve or reject)
        // It will be routed to the new stream on reconnect
      } else {
        // Without resume: complete the stream
        stream.done = true;
        if (stream.pending) {
          const { resolve } = stream.pending;
          stream.pending = null;
          resolve({ value: undefined, done: true });
        }
        activeClientStreams.delete(stream.sid);
      }
    }

    if (reconnectConfig) {
      const sentinel = new ReconnectingError();
      for (const handler of pending.values()) {
        handler.reject(sentinel);
      }
      pending.clear();

      emit("disconnect");
      clearConnectionState();

      if (pendingTerminals.size > 0 || hasResumableStreams()) {
        isReconnecting = true;
        scheduleReconnect();
      } else {
        transport = null;
      }
    } else {
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

  function hasResumableStreams(): boolean {
    for (const stream of activeClientStreams.values()) {
      if (stream.resume && !stream.cancelled && !stream.done) return true;
    }
    return false;
  }

  function cancelReconnectIfIdle() {
    if (!isReconnecting) return;
    if (pendingTerminals.size > 0 || hasResumableStreams()) return;
    scheduler?.cancel();
    isReconnecting = false;
    exhausted = false;
    if (transport) {
      const stale = transport;
      transport = null;
      try {
        stale.close();
      } catch {}
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
      scheduleReconnect();
      return;
    }

    wireTransport(newTransport);
  }

  function replayPendingTerminals() {
    const snapshot = [...pendingTerminals];
    pendingTerminals.clear();
    for (const pt of snapshot) {
      issueOperation(pt);
    }

    // Resume streams: call resume(), which calls openStream() to create a
    // new server-side stream. We queue the old state so that when openStream
    // registers in pendingStreamStarts, the stream_start handler binds the
    // old state instead of the new one.
    const streamsToResume = [...activeClientStreams.values()].filter(
      (s) => s.resume && !s.cancelled,
    );
    for (const oldState of streamsToResume) {
      activeClientStreams.delete(oldState.sid);
      if (oldState.resume) {
        // Queue the old state for rebinding when the next stream registers
        oldState.sid = 0;
        oldState.consumed = 0;
        oldState.framesSinceGrant = 0;
        oldState.lastGrantSize = oldState.windowSize;
        resumeQueue.push(oldState);
        try {
          oldState.resume(); // triggers openStream → stream_start to server
        } catch (err) {
          // resume() threw — reject the held next()
          resumeQueue.splice(resumeQueue.indexOf(oldState), 1);
          if (oldState.pending) {
            oldState.pending.reject(err);
            oldState.pending = null;
          }
        }
      }
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

    const cleanup = (token?: number) => {
      resolvedEdges.delete(key);
      const knownToken = token ?? pathToTokenSync.get(key);
      if (knownToken !== undefined) {
        pathToTokenSync.delete(key);
        tokenBirthCount.delete(knownToken);
      }
    };

    const promise = resolveEdgePath(parentPath)
      .then(async (parentToken) => {
        await ready;
        // Proactive replay: if parent token nears the window edge, replay its path
        let tok = parentToken;
        const parentBirth = tokenBirthCount.get(tok);
        if (
          tok !== 0 &&
          parentBirth !== undefined &&
          sendCount - parentBirth >= tokenWindow
        ) {
          // Token is at or past the window edge — clear and re-resolve parent
          const parentKey = pathKey(parentPath);
          resolvedEdges.delete(parentKey);
          pathToTokenSync.delete(parentKey);
          tokenBirthCount.delete(tok);
          tok = await resolveEdgePath(parentPath);
        }
        const token = nextToken++;
        sendCount++;
        tokenBirthCount.set(token, sendCount);
        pathToTokenSync.set(key, token);
        const msgId = nextMessageId++;
        const edgeName = typeof seg === "string" ? seg : seg[0];
        const args = typeof seg === "string" ? [] : (seg.slice(1) as unknown[]);

        const msg: ClientMessage = {
          op: "edge",
          tok: tok,
          edge: edgeName,
          ...(args.length > 0 && { args }),
        };

        pending.set(msgId, {
          resolve: () => {},
          reject: () => {
            cleanup(token);
          },
        });

        try {
          transport!.send(serializer.stringify(msg));
        } catch (err) {
          pending.delete(msgId);
          cleanup(token);
          throw err;
        }

        return token;
      })
      .catch((err) => {
        cleanup();
        throw err;
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
      const classified = classifyPath(pt.path, schema);
      const { edgePath, terminal } = classified;

      // Handle stream calls
      if (classified.stream) {
        // Streams are not resolved via issueOperation — they use openStream
        throw new RpcError(
          "INVALID_PATH",
          "Streams should be opened via openStream",
        );
      }

      const token = await resolveEdgePath(edgePath);
      const edgeKey = pathKey(edgePath);

      if (terminal) {
        const lastSegment = pt.path[pt.path.length - 1];
        const isPropertyRead = typeof lastSegment === "string";

        if (isPropertyRead) {
          // 1. Check liveDataCache
          const cached = liveDataCache.get(edgeKey);
          if (cached && Object.hasOwn(cached, terminal.name)) {
            return cached[terminal.name];
          }

          // 2. Check getCache
          const getCacheKey = `${edgeKey}:${terminal.name}`;
          const existingGet = getCache.get(getCacheKey);
          if (existingGet) return existingGet;

          // 3. Cache miss: send get
          const msgId = nextMessageId++;
          const msg: ClientMessage = {
            op: "get",
            tok: token,
            name: terminal.name,
          };
          let rejectPending!: (err: unknown) => void;
          const promise = new Promise((resolve, reject) => {
            rejectPending = reject;
            pending.set(msgId, {
              resolve,
              reject: (err: unknown) => {
                getCache.delete(getCacheKey);
                reject(err);
              },
            });
          });
          getCache.set(getCacheKey, promise);
          try {
            transport!.send(serializer.stringify(msg));
          } catch (err) {
            pending.delete(msgId);
            getCache.delete(getCacheKey);
            rejectPending(err);
          }
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
        return new Promise((resolve, reject) => {
          pending.set(msgId, { resolve, reject });
          try {
            transport!.send(serializer.stringify(msg));
          } catch (err) {
            pending.delete(msgId);
            reject(err);
          }
        });
      } else {
        // Data load
        const cached = liveDataCache.get(edgeKey);
        if (cached) {
          let proxy = dataProxyCache.get(edgeKey);
          if (!proxy) {
            proxy = createDataProxy(backend, edgePath, cached);
            dataProxyCache.set(edgeKey, proxy);
          }
          return proxy;
        }

        const inflight = dataLoadCache.get(edgeKey);
        if (inflight) return inflight;

        const msgId = nextMessageId++;
        const msg: ClientMessage = { op: "data", tok: token };
        let rejectPending!: (err: unknown) => void;
        const promise = new Promise((resolve, reject) => {
          rejectPending = reject;
          pending.set(msgId, {
            resolve: (data: any) => {
              liveDataCache.set(edgeKey, data);
              const proxy = createDataProxy(backend, edgePath, data);
              dataProxyCache.set(edgeKey, proxy);
              resolve(proxy);
            },
            reject: (err: unknown) => {
              dataLoadCache.delete(edgeKey);
              reject(err);
            },
          });
        });
        dataLoadCache.set(edgeKey, promise);
        try {
          transport!.send(serializer.stringify(msg));
        } catch (err) {
          pending.delete(msgId);
          dataLoadCache.delete(edgeKey);
          rejectPending(err);
        }
        return promise;
      }
    });

    work.then(
      (value) => {
        pendingTerminals.delete(pt);
        replayAttempts.delete(pathKey(pt.path));
        pt.resolve(value);
      },
      (err) => {
        if (err instanceof ReconnectingError) {
          return;
        }
        // Handle TOKEN_EXPIRED: replay the path
        if (err instanceof TokenExpiredError) {
          const key = pathKey(pt.path);
          const attempts = (replayAttempts.get(key) ?? 0) + 1;
          if (attempts > MAX_REPLAYS) {
            replayAttempts.delete(key);
            pendingTerminals.delete(pt);
            pt.reject(
              new RpcError("REPLAY_LIMIT", "Token replay limit exceeded"),
            );
            return;
          }
          replayAttempts.set(key, attempts);
          // Clear the edge cache for this path so it's re-resolved
          const { edgePath } = classifyPath(pt.path, schema);
          for (let i = 0; i < edgePath.length; i++) {
            const subPath = edgePath.slice(0, i + 1);
            const subKey = pathKey(subPath);
            resolvedEdges.delete(subKey);
            const tok = pathToTokenSync.get(subKey);
            if (tok !== undefined) {
              pathToTokenSync.delete(subKey);
              tokenBirthCount.delete(tok);
            }
          }
          // Re-issue the operation
          issueOperation(pt);
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
            // Store in persistent cache
            if (result.value && typeof result.value === "object") {
              liveDataCache.set(
                edgePathKey,
                result.value as Record<string, unknown>,
              );
            }
            let proxy = dataProxyCache.get(edgePathKey);
            if (!proxy) {
              proxy = createDataProxy(
                backend,
                edgePath,
                result.value as Record<string, unknown>,
              );
              dataProxyCache.set(edgePathKey, proxy);
            }
            return Promise.resolve(proxy);
          }
        }
      }

      ensureConnected();
      return new Promise((resolve, reject) => {
        const pt: PendingTerminal = { resolve, reject, path };
        pendingTerminals.add(pt);
        issueOperation(pt);
      });
    },

    subscribe(path: PathSegments, callback: () => void): () => void {
      const key = pathKey(path);
      let subs = pathSubscribers.get(key);
      if (!subs) {
        subs = new Set();
        pathSubscribers.set(key, subs);
      }
      subs.add(callback);

      return () => {
        subs!.delete(callback);
        if (subs!.size === 0) {
          pathSubscribers.delete(key);
        }
      };
    },

    isStream(name: string, parentPath: PathSegments): boolean {
      // Walk schema to find the type index for parentPath, then check if name is in streams
      let typeIndex = 0;
      for (const seg of parentPath) {
        const segName = typeof seg === "string" ? seg : seg[0];
        const nodeSchema = schema[typeIndex];
        if (!nodeSchema) return false;
        const targetIndex = nodeSchema.edges[segName];
        if (targetIndex === undefined) return false;
        typeIndex = targetIndex;
      }
      const nodeSchema = schema[typeIndex];
      return nodeSchema?.streams?.includes(name) ?? false;
    },

    openStream(
      path: PathSegments,
      name: string,
      args: unknown[],
    ): RpcStream<unknown> {
      ensureConnected();

      const initialCredits = 8;
      const streamState: ClientStreamState = {
        sid: 0, // will be set when server responds
        windowSize: initialCredits,
        consumed: 0,
        framesSinceGrant: 0,
        lastGrantSize: initialCredits,
        pending: null,
        buffer: [],
        done: false,
        error: null,
        cancelled: false,
        creditTimer: null,
      };

      // Send stream_start and register for early data
      ready.then(async () => {
        const token = await resolveEdgePath(path);

        const msgId = nextMessageId++;
        // If there's a resume pending, use the old state instead of the new one
        const isResume = resumeQueue.length > 0;
        const effectiveState = isResume ? resumeQueue.shift()! : streamState;
        const startCredits = effectiveState.windowSize;
        effectiveState.framesSinceGrant = 0;
        effectiveState.lastGrantSize = startCredits;
        // Pre-register so stream_start handler can associate data immediately
        pendingStreamStarts.set(msgId, effectiveState);

        const msg: ClientMessage = {
          op: "stream_start",
          tok: token,
          stream: name,
          credits: startCredits,
          ...(args.length > 0 && { args }),
        };

        pending.set(msgId, {
          resolve: () => {},
          reject: (err: unknown) => {
            pendingStreamStarts.delete(msgId);
            effectiveState.done = true;
            effectiveState.error = err;
            if (effectiveState.pending) {
              effectiveState.pending.reject(err);
              effectiveState.pending = null;
            }
          },
        });
        try {
          transport!.send(serializer.stringify(msg));
        } catch (err) {
          pending.delete(msgId);
          pendingStreamStarts.delete(msgId);
          effectiveState.done = true;
          effectiveState.error = err;
          if (effectiveState.pending) {
            effectiveState.pending.reject(err);
            effectiveState.pending = null;
          }
        }
      });

      const stream: RpcStream<unknown> = {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<unknown>> {
              // If there's buffered data, return it
              if (streamState.buffer.length > 0) {
                const value = streamState.buffer.shift()!;
                streamState.consumed++;
                maybeGrantCredits(streamState);
                return Promise.resolve({ value, done: false });
              }
              // If done
              if (streamState.done) {
                if (streamState.error) {
                  return Promise.reject(streamState.error);
                }
                return Promise.resolve({
                  value: undefined,
                  done: true as const,
                });
              }
              // Wait for next value
              return new Promise((resolve, reject) => {
                streamState.pending = { resolve, reject };
              });
            },
            return(): Promise<IteratorResult<unknown>> {
              if (!streamState.cancelled) {
                streamState.cancelled = true;
                if (streamState.sid !== 0) {
                  // Already have a server-assigned SID — cancel immediately
                  if (transport) {
                    try {
                      transport.send(
                        serializer.stringify({
                          op: "stream_cancel",
                          sid: streamState.sid,
                        }),
                      );
                    } catch {}
                  }
                  activeClientStreams.delete(streamState.sid);
                }
                // If sid === 0, the stream_start handler will send cancel
                // when the response arrives (see cancelled check below).
              }
              streamState.done = true;
              if (streamState.pending) {
                streamState.pending.resolve({ value: undefined, done: true });
                streamState.pending = null;
              }
              cancelReconnectIfIdle();
              return Promise.resolve({ value: undefined, done: true as const });
            },
          };
        },
        cancel() {
          const iter = stream[Symbol.asyncIterator]();
          iter.return?.();
        },
      };

      Object.defineProperty(stream, "resume", {
        get() {
          return streamState.resume;
        },
        set(fn) {
          streamState.resume = fn;
        },
        configurable: true,
        enumerable: true,
      });

      return stream;
    },
  };

  // Override serializer to produce data proxies for references and paths at parse time
  serializer = createClientSerializer(
    options,
    (value) => {
      const [path, data] = value as [PathSegments, Record<string, unknown>];
      const refPathKey = pathKey(path);
      // Update persistent cache
      liveDataCache.set(refPathKey, data);
      dataProxyCache.delete(refPathKey);
      // Clear property caches
      const prefix = refPathKey + ":";
      for (const key of getCache.keys()) {
        if (key.startsWith(prefix)) getCache.delete(key);
      }
      dataLoadCache.delete(refPathKey);

      // Evict cached descendant edges
      for (const edgeKey of resolvedEdges.keys()) {
        if (isDescendantPathKey(refPathKey, edgeKey)) {
          resolvedEdges.delete(edgeKey);
          const tok = pathToTokenSync.get(edgeKey);
          if (tok !== undefined) {
            pathToTokenSync.delete(edgeKey);
            tokenBirthCount.delete(tok);
          }
        }
      }
      // Invalidate descendants in all caches
      for (const k of liveDataCache.keys()) {
        if (isDescendantPathKey(refPathKey, k)) liveDataCache.delete(k);
      }
      for (const k of dataProxyCache.keys()) {
        if (isDescendantPathKey(refPathKey, k)) dataProxyCache.delete(k);
      }
      for (const k of dataLoadCache.keys()) {
        if (isDescendantPathKey(refPathKey, k)) dataLoadCache.delete(k);
      }
      for (const k of getCache.keys()) {
        if (isDescendantPathKey(refPathKey, k)) getCache.delete(k);
      }

      // Notify subscribers (invalidation propagation)
      notifyPath(refPathKey);
      for (const subKey of pathSubscribers.keys()) {
        if (isDescendantPathKey(refPathKey, subKey)) notifyPath(subKey);
      }
      // Notify ancestors
      let ancestorPath = path.slice();
      while (ancestorPath.length > 0) {
        ancestorPath = ancestorPath.slice(0, -1);
        notifyPath(pathKey(ancestorPath));
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
    if (stale) stale.close();
  }

  let closed = false;

  function close() {
    if (closed) return;
    closed = true;

    scheduler?.cancel();
    hydrationCache.drop();

    const err = new RpcError("CLIENT_CLOSED", "Client closed");
    for (const handler of pending.values()) {
      handler.reject(err);
    }
    pending.clear();

    for (const pt of pendingTerminals) {
      pt.reject(err);
    }
    pendingTerminals.clear();

    // Cancel all streams
    const t = options.timers ?? defaultTimers();
    for (const stream of activeClientStreams.values()) {
      if (stream.creditTimer) {
        t.clearTimeout(stream.creditTimer);
        stream.creditTimer = null;
      }
      stream.cancelled = true;
      stream.done = true;
      if (stream.pending) {
        stream.pending.reject(err);
        stream.pending = null;
      }
    }
    activeClientStreams.clear();

    if (transport) transport.close();
  }

  const stub = createStub(backend, []);

  // Register backend for invalidate/evict (subscribe is on the backend directly)
  backendInvalidators.set(backend, doInvalidate);
  backendEvictors.set(backend, doEvict);

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
