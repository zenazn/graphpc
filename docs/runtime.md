# Runtime Lifecycle and Resilience

When to read this page: after [Mental Model](mental-model.md), before tuning production settings.

This page is the runtime map. Use it first, then jump into focused docs for details.

## Most Teams Only Need This

- A client session is split into epochs, each tied to one live connection.
- SSR hydration uses a short-lived hydration epoch before live traffic.
- Within an epoch, node and property reads coalesce; method calls never do.
- Reconnect creates a fresh epoch (fresh cache/tokens/context) and may replay in-flight ops.
- Mutation delivery is at-least-once during reconnect scenarios; use idempotency keys for non-idempotent writes.

## Lifecycle Timeline

1. Optional SSR using `createSSRClient(...)`
2. Optional hydration epoch via `client.hydrate(...)`
3. First live epoch starts on first transport-needed cache miss
4. Active live epochs continue while traffic/in-flight work exists
5. Epoch ends on idle timeout or disconnect (cache is dropped)
6. Unexpected disconnect triggers lazy or eager reconnect depending on pending work

## Cache and Coalescing Boundaries

Inside a live epoch:

- edge traversals cache by path
- `await node` caches full-node data
- `await node.prop` caches by property
- `@method` calls are never cached/coalesced

Read-after-write caveat: plain `await node` after mutation can read stale same-epoch cache. Return `ref(...)` from mutations to refresh cache at canonical path.

Details: [Epochs and Caching](caching.md).

## Hydration Boundary

Hydration epoch differs from live epochs:

- data source is SSR payload, not WebSocket
- short client-side timeout (`hydrationTimeout`, default 250ms)
- cached SSR-recorded method calls can replay during hydration only

When hydration ends, cache is dropped and the next transport-needed miss opens a live connection.

Details: [SSR and Hydration](ssr-and-hydration.md).

## Reconnection Boundary

- Reconnection is enabled by default.
- Idle disconnects reconnect lazily (next operation).
- In-flight disconnects reconnect eagerly with backoff and replay pending work.
- Retry exhaustion emits `reconnectFailed` and rejects pending/new operations with `ConnectionLostError`.
- `client.reconnect()` resets retries and immediately tries again.

Details: [Reconnection](reconnection.md).

## Practical Guidance

- Hydrate before any client-side awaits.
- Return `ref(...)` from mutations when immediate fresh reads matter.
- Treat non-idempotent writes as at-least-once under reconnect.
- If auth/session changes, end the old connection so the next epoch gets fresh context and visibility.

## Related Docs

- [Epochs and Caching](caching.md)
- [SSR and Hydration](ssr-and-hydration.md)
- [Reconnection](reconnection.md)
- [Production Guide](production.md)
- [Testing](testing.md)
