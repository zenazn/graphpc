# Reconnection & Connection Resilience

## Overview

The client auto-reconnects when the transport drops unexpectedly (server crash, network loss, WebSocket error). Each reconnection starts a new epoch — fresh tokens, fresh cache, fresh server-side context. The client re-establishes state transparently, so callers don't need to handle disconnections manually.

## Enabled by Default

Reconnection is enabled by default. To disable it:

```typescript
const client = createClient<typeof server>(
  { reconnect: false },
  () => new WebSocket("ws://localhost:3000"),
);
```

## Reconnection Strategy

The client reconnects with exponential backoff:

- The first reconnect attempt fires immediately (zero delay).
- The second attempt uses `initialDelay` as its delay, then each subsequent attempt multiplies the previous delay by `multiplier`, up to `maxDelay`.
- After exhausting all attempts, the client gives up.

Defaults:

| Option         | Default | Description                            |
| -------------- | ------- | -------------------------------------- |
| `initialDelay` | 1000ms  | Delay of the first non-immediate retry |
| `maxDelay`     | 30000ms | Ceiling for the backoff                |
| `multiplier`   | 2       | Delay multiplier per attempt           |
| `maxRetries`   | 5       | Maximum number of reconnect attempts   |

All configurable:

```typescript
const client = createClient<typeof server>(
  {
    reconnect: {
      initialDelay: 500,
      maxDelay: 10_000,
      maxRetries: 10,
      multiplier: 1.5,
    },
  },
  () => new WebSocket("ws://localhost:3000"),
);
```

## Connection Lifecycle Events

The client exposes lifecycle events via a typed event emitter:

```typescript
const client = createClient<typeof server>(
  {
    reconnect: { initialDelay: 500, maxDelay: 10_000, maxRetries: 10 },
  },
  () => new WebSocket("ws://localhost:3000"),
);

client.on("disconnect", () => showBanner("Reconnecting…"));
client.on("reconnect", () => hideBanner());
client.on("reconnectFailed", () =>
  showBanner("Connection lost. Please refresh."),
);
```

Remove a listener with `client.off()`:

```typescript
const handler = () => showBanner("Reconnecting…");
client.on("disconnect", handler);
client.off("disconnect", handler);
```

| Event               | Fires when                                              |
| ------------------- | ------------------------------------------------------- |
| `'disconnect'`      | The transport closes unexpectedly                       |
| `'reconnect'`       | A new transport connects and the server sends its hello |
| `'reconnectFailed'` | All `maxRetries` attempts have been exhausted           |

## Request Queuing

If the WebSocket drops while requests are in-flight, their promises do **not** reject. Instead, they're queued internally until the connection is restored.

On successful reconnect, the client replays the necessary edges and re-sends the queued requests. Callers don't need to know a reconnection happened — promises resolve normally once the new connection is established.

```typescript
// This promise survives a disconnect + reconnect transparently
const user = await client.root.users.get("42");
```

## Lazy Path Replay

After reconnecting, the client does **not** eagerly re-walk all previously resolved paths. The new connection starts a new epoch with a clean token space and empty cache.

Paths are re-established lazily: only when a queued or new request needs a to access an edge on the new connection does the client replay that edge. This keeps reconnection lightweight — a client that had traversed hundreds of paths only replays the ones actually needed by pending work.

If the server-side state has changed (node deleted, edge now hidden), the lazy replay surfaces the error normally to the caller — the same error they'd get on a fresh connection.

## Hydration-to-Live Transition

During the hydration epoch, reads are served from the hydration cache. No transport needed.

If a request during the hydration epoch is **not** in the cache (e.g., a user interaction that wasn't part of SSR), it triggers a WebSocket connection and is sent over the wire once connected.

The hydration epoch ends when `client.endHydration()` is called or after the inactivity timeout (default 250ms, configurable via `hydrationTimeout`). After that, the next request that needs data triggers a WebSocket connection, starting the first live epoch. All subsequent requests go through the transport. See [SSR and Hydration](ssr-and-hydration.md).

## Retry Exhaustion

If all reconnect attempts fail, the client:

1. Emits a `'reconnectFailed'` event.
2. Rejects all queued promises with a `ConnectionLostError`.

```typescript
import { ConnectionLostError } from "graphpc";

try {
  const user = await client.root.users.get("42");
} catch (err) {
  if (err instanceof ConnectionLostError) {
    // All reconnection attempts failed
    console.error(err.message); // "All reconnection attempts failed"
  }
}
```

After exhaustion, new operations reject immediately with `ConnectionLostError` — they don't hang. Call `client.reconnect()` to revive the client (see below), or create a new client.

## Manual Reconnection

Call `client.reconnect()` to reset the retry counter and immediately attempt a new connection. This is useful for implementing a "Retry" button or responding to network recovery events like `navigator.onLine`.

```typescript
client.on("reconnectFailed", () => {
  showRetryButton();
});

retryButton.addEventListener("click", () => {
  client.reconnect();
});

// Or respond to browser online events
window.addEventListener("online", () => {
  client.reconnect();
});
```

`reconnect()` is a no-op when:

- The client is already connected (not reconnecting or exhausted)
- The client has been closed via `close()`
- Reconnection is disabled (`reconnect: false`)

When called during an active reconnection (before exhaustion), it cancels the current backoff timer, resets the retry counter, and starts fresh — useful if you have external knowledge that the network is back.

On success, the `"reconnect"` event fires normally. If the new attempts also fail, `"reconnectFailed"` fires again and the client returns to the exhausted state. You can call `reconnect()` again to retry.

## Mutation Safety

### The Risk

When a connection drops while a mutation is in-flight, the client replays it after reconnecting. If the server already processed the original request, the mutation executes **twice**. GraphPC provides **at-least-once** delivery, not exactly-once.

### What the Library Guarantees

| Guarantee              | Provided?                                             |
| ---------------------- | ----------------------------------------------------- |
| At-least-once delivery | Yes — pending requests replay on reconnect            |
| At-most-once delivery  | No — no deduplication of replayed requests            |
| Duplicate detection    | No — the server treats replayed requests as new       |
| Ordering preservation  | Yes — replayed requests maintain their original order |

### When This Matters

**Safe to replay (idempotent):**

```typescript
// Setting a value to a fixed result — replaying produces the same state
await client.root.users.get("42").updateEmail("alice@example.com");

// Reads are always safe
const user = await client.root.users.get("42");
```

**Dangerous to replay (non-idempotent):**

```typescript
// Incrementing — replaying adds twice
await client.root.account.addCredits(100);

// Creating resources — replaying creates duplicates
await client.root.posts.create({ title: "Hello" });

// Charging money — replaying charges twice
await client.root.billing.charge(29_99);
```

Consider adding an idempotency key (e.g., a UUID) to non-idempotent methods so you can deduplicate those requests on the server.

### What About Reads?

Reads (`await node`, method calls that return data) are always safe to replay. A replayed read returns the current server-side state, which may differ from the original request — but that's correct behavior. The client receives fresh data on the new connection.
