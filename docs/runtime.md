# Runtime Lifecycle and Resilience

When to read this page: after [Mental Model](mental-model.md), before tuning production settings.

This page is the runtime map. Use it first, then jump into focused docs for details.

## Most Teams Only Need This

- The client maintains a persistent cache that survives reconnects.
- SSR hydration seeds the persistent cache before live traffic.
- Node and property reads coalesce within the cache; method calls never do.
- Reconnect preserves the cache (same nodes, same promises) and replays in-flight ops.
- The server uses a sliding token window for resource management; expired tokens are replayed automatically by the client.
- Use `invalidate()` and `evict()` to manage cache freshness. Use `subscribe()` for reactivity.
- Mutation delivery is at-least-once during reconnect scenarios; use idempotency keys for non-idempotent writes.

## Lifecycle Timeline

1. Optional SSR using `createSSRClient(...)`
2. Optional hydration phase via `client.hydrate(...)` — seeds persistent cache
3. First connection opens on the first read that needs the server
4. Persistent cache serves reads; new data extends the cache
5. Connection may close on idle timeout or disconnect
6. Unexpected disconnect triggers lazy or eager reconnect depending on pending work
7. On reconnect, persistent cache is preserved — same stubs, same referential identity

## Cache and Coalescing Boundaries

The persistent cache:

- edge traversals cache by path
- `await node` caches full-node data
- `await node.prop` caches by property
- `@method` calls are never cached/coalesced

Read-after-write caveat: plain `await node` after mutation can read stale cache. Return `ref(...)` from mutations to refresh cache at canonical path, or use `invalidate()` to mark data stale.

Use `invalidate(stub)` to mark cached data stale (next read re-fetches). Use `evict(stub)` to remove data from cache entirely. Use `subscribe(stub)` for reactive updates when data changes.

Details: [Caching and Invalidation](caching.md).

## Hydration Boundary

The hydration phase differs from live operation:

- data source is SSR payload, not WebSocket
- short client-side timeout (`hydrationTimeout`, default 250ms)
- cached SSR-recorded method calls can replay during hydration only
- method call results are dropped when hydration ends; all other data persists in the cache

When hydration ends, the next read that needs the server opens a live connection. The persistent cache retains all non-method data from SSR.

Details: [SSR and Hydration](ssr-and-hydration.md).

## Reconnection Boundary

- Reconnection is enabled by default.
- Persistent cache survives reconnects — same nodes, same promises, same referential identity.
- Idle disconnects reconnect lazily (next operation).
- In-flight disconnects reconnect eagerly with backoff and replay pending work.
- Retry exhaustion emits `reconnectFailed` and rejects pending/new operations with `ConnectionLostError`.
- `client.reconnect()` resets retries and immediately tries again.

Details: [Reconnection](reconnection.md).

## Token Window

The server manages tokens using a sliding window (default size: 10000). When a token falls outside the window, it expires. The client detects this proactively and replays the path transparently — application code is unaware that tokens exist. Token expiry only surfaces as `TokenExpiredError` if the replay circuit breaker trips (5 consecutive failures on the same path).

The server also applies LRU eviction with TTL for server-side cache entries, automatically reclaiming resources for idle nodes.

Details: [Protocol Internals](internals.md#token-window).

## Practical Guidance

- Hydrate before any client-side awaits.
- Return `ref(...)` from mutations when immediate fresh reads matter.
- Use `invalidate()` when you need to force a re-fetch without a `ref()` return.
- Use `subscribe()` to react to cache changes in UI frameworks.
- Treat non-idempotent writes as at-least-once under reconnect.
- If auth/session changes, end the old connection so the next connection gets fresh context and visibility.

## Related Docs

- [Caching and Invalidation](caching.md)
- [SSR and Hydration](ssr-and-hydration.md)
- [Reconnection](reconnection.md)
- [Production Guide](production.md)
- [Testing](testing.md)
