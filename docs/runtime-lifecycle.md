# Runtime Lifecycle

When to read this page: after [SSR and Hydration](ssr-and-hydration.md) and [Epochs and Caching](caching.md), when you want the full lifecycle in one timeline.

This page explains how a GraphPC client session moves from SSR to live traffic and how it recovers from disconnects.

For exact cache and replay guarantees, see:

- [Epochs and Caching](caching.md)
- [SSR and Hydration](ssr-and-hydration.md)
- [Reconnection](reconnection.md)

## Phases

1. **SSR (optional)**
   Components run against `createSSRClient(...)`. Traversals and results are recorded.
2. **Hydration epoch (optional)**
   Client calls `hydrate(...)` / `hydrateString(...)`. Reads are served from hydration payload.
3. **First live epoch**
   First cache miss requiring wire access opens a WebSocket. Epoch cache starts empty.
4. **Active live epochs**
   Requests coalesce and cache within each connection-bound epoch.
5. **Epoch end**
   Idle timeout or connection close ends the epoch and clears epoch cache.
6. **Reconnect path (if disconnected unexpectedly)**
   Client reconnects with backoff and replays pending work (or reconnects lazily when idle).

## Why This Model Exists

GraphPC optimizes for:

- fast local navigation (`@edge` is synchronous on the client)
- predictable cache lifetime (scoped to epochs)
- resilience to transient disconnects (queued requests replay)
- no long-lived server session state beyond a connection epoch

## Practical Guidance

- If you do SSR, call `hydrate(...)` before any client awaits.
- Return `ref(...)` after mutations when callers need immediate fresh data.
- Treat non-idempotent mutations as at-least-once under reconnect; use idempotency keys.
- If auth context changes, close/revoke the connection so the next epoch rebuilds schema and context.

## Related Docs

- [Architecture](architecture.md) for object-graph semantics
- [Production Guide](production.md) for timeouts, limits, and observability
- [Testing](testing.md) for mock transport patterns
