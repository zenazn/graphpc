# Production Guide

When to read this page: after your first real deployment path is working in development.

This page is the baseline policy guide for production GraphPC deployments.

For deep implementation examples (OTel middleware, abort-signal integration patterns, and concrete rate-limit wiring), see [Production Operations (Advanced)](production-operations.md).

## Most Teams Only Need This

- Enable redaction in production (`redactErrors`).
- Log `operationError` with `errorId` for support correlation.
- Set connection limits (`maxTokens`, `maxPendingOps`, `maxQueuedOps`) and transport payload limits.
- Set `maxOperationTimeout` and use `abortSignal()` in long-running work.
- Treat reconnect replay as at-least-once; use idempotency keys for non-idempotent writes.
- Add lightweight observability via `connection`, `disconnect`, and `operation` events.

## Minimum Baseline

Start with conservative limits and tune from real latency/load measurements.

```typescript
const server = createServer(
  {
    redactErrors: true,
    maxTokens: 5000,
    maxPendingOps: 20,
    maxQueuedOps: 1000,
    maxOperationTimeout: 30_000,
    idleTimeout: 10_000,
  },
  (ctx) => new Api(),
);
```

Then add:

- transport payload limits at the WebSocket layer
- server-side error correlation logging (`operationError`)
- idempotency keys for risky mutation methods

## Error Redaction

In production (`NODE_ENV=production`), GraphPC can redact unregistered errors before they are sent to clients.

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
4. user handler may keep running unless it cooperatively aborts

```typescript
createServer({ maxOperationTimeout: 10_000 }, factory);
```

Use `abortSignal()` in I/O paths to make timeout cancellation effective.

See deep usage patterns: [Production Operations — Abort Signals](production-operations.md#abort-signals).

## Message Size Limits

GraphPC does not enforce payload size limits directly; configure them at transport level.

- Bun: `maxPayloadLength` (default 16MB)
- ws: `maxPayload` (default 100MB)

Recommendation: set an explicit limit (for many APIs, around 1MB is a reasonable starting point).

## Connection Limits

| Option          | Default | Description                                  |
| --------------- | ------- | -------------------------------------------- |
| `maxTokens`     | 9000    | Max edge traversals per connection           |
| `maxPendingOps` | 20      | Max concurrent executing operations          |
| `maxQueuedOps`  | 1000    | Max total in-flight messages before close    |
| `idleTimeout`   | 5000ms  | Inactivity timeout before closing connection |

```typescript
createServer(
  {
    maxTokens: 5000,
    maxPendingOps: 10,
    maxQueuedOps: 500,
    idleTimeout: 10_000,
  },
  factory,
);
```

## Rate Limiting

Primary recommendation: rate-limit before WebSocket upgrade.

If you need dynamic in-request controls (for example per-user plans), enforce in graph code using context and close/reject abusive connections.

Detailed Bun/ws and in-request examples: [Production Operations — Rate Limiting](production-operations.md#rate-limiting).

## Request IDs

Store a per-connection request ID in context and include it in logs to correlate events.

Detailed upgrade/context examples: [Production Operations — Request IDs](production-operations.md#request-ids).

## At-Least-Once Delivery

Reconnect replay can duplicate in-flight mutations. Treat mutation delivery as at-least-once and include idempotency keys for non-idempotent operations.

See [Reconnection — Mutation Safety](reconnection.md#mutation-safety).

## Advanced Operations

For implementation-heavy guidance and reusable examples:

- [Production Operations (Advanced)](production-operations.md)
