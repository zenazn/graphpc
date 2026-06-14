# Production Guide

When to read this page: after your first real deployment path is working in development.

This page is the baseline policy guide for production GraphPC deployments.

For deep implementation examples (OTel middleware, abort-signal integration patterns, and concrete rate-limit wiring), see [Production Operations (Advanced)](production-operations.md).

## Most Teams Only Need This

- Enable redaction in production (`redactErrors`).
- Log `operationError` with `errorId` for support correlation.
- Set connection limits (`tokenWindow`, `maxStreams`, `maxPendingOps`, `maxQueuedOps`, `rateLimit`) and transport payload limits.
- Set `maxOperationTimeout` and use `abortSignal()` in long-running work.
- Treat reconnect replay as at-least-once; use idempotency keys for non-idempotent writes.
- Add lightweight observability via `connection`, `disconnect`, and `operation` events.

## Minimum Baseline

Start with conservative limits and tune from real latency/load measurements.

```typescript
const server = createServer(
  {
    redactErrors: true,
    tokenWindow: 10_000,
    maxStreams: 32,
    maxPendingOps: 20,
    maxQueuedOps: 1000,
    maxDepth: 64,
    maxOperationTimeout: 30_000,
    idleTimeout: 60_000,
  },
  (ctx) => new Api(),
);
```

Then add:

- transport payload limits at the WebSocket layer
- server-side error correlation logging (`operationError`)
- idempotency keys for risky mutation methods

## Error Redaction

GraphPC can redact unregistered errors before they are sent to clients. `redactErrors` defaults to on when `NODE_ENV=production` and off otherwise; set it explicitly to override.

```typescript
createServer({ redactErrors: true }, factory);
```

Redaction target: errors that are not built-in GraphPC errors, not registered custom serializers, and not explicitly thrown `RpcError` values.

Never redacted:

- built-in GraphPC error classes (`ValidationError`, `EdgeNotFoundError`, etc.)
- registered custom error types
- directly thrown `RpcError` values

When redaction applies, client message becomes `"Internal server error"`.

## Error Reporting

Every error response includes an `errorId` UUID. Log that ID server-side and surface it client-side.

```typescript
server.on("operationError", (ctx, info) => {
  console.error(`[${info.errorId}]`, info.error);
});
```

```typescript
import { getErrorUuid } from "graphpc/client";

try {
  await client.root.posts.get("42");
} catch (err) {
  const errorId = getErrorUuid(err);
  // include errorId in user-visible support message or logs
}
```

`operationError` is read-only and only covers errors transmitted to clients (parse failures still use `"error"`).

## Observability

Use server events for tracing/metrics/logging:

- `connection`
- `disconnect`
- `operation` (middleware-style wrapper)
- `operationError`

Keep policy/auth decisions in graph code (`@hidden`, edge getters, method logic), not in observability handlers.

Advanced event semantics and OpenTelemetry wiring: [Production Operations (Advanced)](production-operations.md#observability).

## Operation Timeout

`maxOperationTimeout` (default `30_000`, `0` disables) sets a per-operation limit.

When it fires:

1. operation abort signal fires
2. `OPERATION_TIMEOUT` is sent to the client
3. edge tokens involved are marked failed

**Important:** The timeout does _not_ kill the server-side handler. It fires the abort signal and responds to the client, but the handler keeps running unless it cooperatively checks `abortSignal()`. Pass the signal to all I/O calls (`fetch`, database queries, etc.) so that timeout cancellation actually stops work:

```typescript
import { abortSignal } from "graphpc";

// GOOD: handler aborts when timeout fires
@method(z.string())
async search(query: string): Promise<Result[]> {
  return db.query("SELECT ...", [query], { signal: abortSignal() });
}
```

Without `abortSignal()`, the handler will continue consuming server resources (memory, CPU, database connections) after the client has already received the timeout error.

```typescript
createServer({ maxOperationTimeout: 10_000 }, factory);
```

See deep usage patterns: [Production Operations — Abort Signals](production-operations.md#abort-signals).

## Message Size Limits

The most effective payload cap is at the transport layer — configure it there. If a message exceeds the transport limit, the connection is dropped silently.

- Bun: `maxPayloadLength` (default 16MB)
- ws: `maxPayload` (default 100MB)

As defense-in-depth, GraphPC also accepts a `maxMessageBytes` server option (default `0` = disabled): a decoded inbound frame larger than this closes the connection before any parse/cache-key work. Set it (or a transport cap, ideally both) in production. Note that even without it, the server bounds the size of the cache key it derives from any single edge argument, so an oversized argument cannot bloat per-connection key storage.

Always set an explicit limit. For many APIs, 1MB is a reasonable starting point:

```typescript
// Bun
Bun.serve({
  websocket: {
    maxPayloadLength: 1024 * 1024, // 1 MB
    ...server.wsHandlers((data) => data),
  },
});

// ws
const wss = new WebSocket.Server({ maxPayload: 1024 * 1024 });
```

If a method deterministically returns data larger than the limit, every call will drop the connection, trigger a reconnect, replay the call, and drop again — an infinite loop. Use `@stream` to chunk large payloads instead.

## Connection Limits

| Option            | Default           | Description                                         |
| ----------------- | ----------------- | --------------------------------------------------- |
| `tokenWindow`     | 10000             | Sliding window of valid tokens                      |
| `maxStreams`      | 32                | Max concurrent streams per connection               |
| `maxMessageBytes` | 0 (disabled)      | Max decoded inbound frame size before close         |
| `maxCredits`      | 256               | Max stream credits the server will honor at once    |
| `maxPendingOps`   | 20                | Max concurrent executing operations                 |
| `maxQueuedOps`    | 1000              | Max total in-flight messages before close           |
| `maxDepth`        | 64                | Max edge traversal depth per connection             |
| `idleTimeout`     | 60000ms           | Inactivity timeout before closing connection        |
| `lruTTL`          | 60000ms           | Idle time before an unpinned server node is evicted |
| `rateLimit`       | 200 burst, 50/sec | Per-connection token bucket (`false` to disable)    |

```typescript
createServer(
  {
    tokenWindow: 20_000,
    maxStreams: 64,
    maxPendingOps: 10,
    maxQueuedOps: 500,
    idleTimeout: 120_000,
  },
  factory,
);
```

## Graceful Shutdown

`server.close()` stops accepting new connections and shuts down existing ones.

```typescript
process.on("SIGTERM", async () => {
  await server.close({ gracePeriod: 10_000 });
  process.exit(0);
});
```

Shutdown sequence:

1. New connections are rejected (`handle()` closes them immediately).
2. All active connections' abort signals fire.
3. In-progress operations and streams clean up (handlers that use `abortSignal()` abort cooperatively).
4. After `gracePeriod` ms (default 5000), remaining connections are force-closed.
5. The returned promise resolves when all connections are gone.

`close()` is idempotent — calling it again returns the same promise. Clients with reconnect enabled will reconnect to a new server instance.

## Half-Open Connection Detection

`pingInterval` (default `30_000`, `0` disables) sends protocol-level pings to detect half-open connections. If no pong is received within `pingTimeout` ms (default `10_000`), the connection is closed.

```typescript
createServer(
  {
    pingInterval: 30_000,
    pingTimeout: 10_000,
  },
  factory,
);
```

Pings do not count as application activity — a connection with no real traffic still times out via `idleTimeout` even if pings succeed. Request messages (edge/get/data/stream_start) reset the ping timer; stream flow-control messages do not, so a connection that is only consuming a stream is still pinged on schedule (harmless — its pongs keep it alive).

## Rate Limiting

GraphPC includes a built-in per-connection token bucket rate limiter, **enabled by default** (200 burst, 50/sec refill). It protects against runaway clients (e.g., infinite invalidation loops). Exhausted connections receive `RATE_LIMITED` errors on individual operations — the connection stays open. Stream flow-control messages (`stream_credit`, `stream_cancel`) consume 0.1 tokens each — cheap enough for normal backpressure but still bounded.

**Stream egress is metered too.** Each `stream_data` frame the server pushes costs one token from the same bucket. When the bucket is empty the pump pauses and resumes as the bucket refills, so a client cannot use cheap `stream_credit` grants to drive unbounded serialization/egress work — total per-connection work (ops _and_ stream frames) stays within the configured `refillRate`. Sustained stream throughput is therefore bounded by `refillRate` (with a `bucketSize` burst); size the bucket/refill accordingly for high-throughput streams, or set `rateLimit: false` to disable metering entirely.

```typescript
createServer(
  {
    rateLimit: { bucketSize: 200, refillRate: 50 }, // defaults
    // rateLimit: false,  // disable
  },
  factory,
);
```

Monitor via `server.on("rateLimit", (ctx, info) => ...)`.

For IP-based or connection-level rate limiting, rate-limit before WebSocket upgrade. For dynamic in-request controls (per-user plans), enforce in graph code using context.

Detailed examples: [Production Operations — Rate Limiting](production-operations.md#rate-limiting).

## Request IDs

Store a per-connection request ID in context and include it in logs to correlate events.

Detailed upgrade/context examples: [Production Operations — Request IDs](production-operations.md#request-ids).

## At-Least-Once Delivery

Reconnect replay can duplicate in-flight mutations. Treat mutation delivery as at-least-once and include idempotency keys for non-idempotent operations.

See [Reconnection — Mutation Safety](reconnection.md#mutation-safety).

## Advanced Operations

For implementation-heavy guidance and reusable examples:

- [Production Operations (Advanced)](production-operations.md)
