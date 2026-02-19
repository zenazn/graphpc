# Production Guide

This guide covers server hardening, error handling, and operational concerns for deploying GraphPC in production.

## Error Redaction

By default in production (`NODE_ENV=production`), GraphPC redacts unregistered errors before sending them to clients. This prevents leaking internal implementation details (stack traces, database errors, etc.) to end users.

```typescript
const server = createServer(
  { redactErrors: true }, // explicit; auto-detected from NODE_ENV in production
  (ctx) => new Api(),
);
```

**What gets redacted:** Only errors that are _not_ intentional client-facing errors — i.e., thrown values that are neither built-in error classes (`RpcError`, `ValidationError`, etc.) nor user-registered custom types. These are the errors that currently become `RpcError("EDGE_ERROR", ...)`, `RpcError("GET_ERROR", ...)`, or `RpcError("DATA_ERROR", ...)`. When redacted, the message is replaced with `"Internal server error"`.

**What is never redacted:**

- Built-in error classes (`ValidationError`, `EdgeNotFoundError`, `MethodNotFoundError`, etc.)
- User-registered custom error types (detected via `serializer.handles(err)`)
- `RpcError` instances thrown directly by user code

Override auto-detection with an explicit `true` or `false`:

```typescript
// Always redact (e.g., staging environments)
createServer({ redactErrors: true }, factory);

// Never redact (e.g., development)
createServer({ redactErrors: false }, factory);
```

## Error Reporting

Every error response from the server includes an `errorId` (UUID). Use the `operationError` event to log errors with their IDs for correlation:

```typescript
server.on("operationError", (ctx, info) => {
  // info.error    — the original (unredacted) error
  // info.errorId  — the UUID sent to the client
  // info.redacted — whether the client-facing error was redacted

  console.error(`[${info.errorId}] Error:`, info.error);

  // Sentry example:
  Sentry.captureException(info.error, {
    tags: { errorId: info.errorId, redacted: String(info.redacted) },
  });
});
```

On the client, retrieve the error UUID for support tickets or logs:

```typescript
import { getErrorUuid } from "graphpc/client";

try {
  await client.root.posts.get("42");
} catch (err) {
  const uuid = getErrorUuid(err);
  if (uuid) {
    showError(`Something went wrong. Reference: ${uuid}`);
  }
}
```

The `operationError` event fires for every error transmitted to a client. It does not fire for parse failures (those use the existing `"error"` event). The handler is read-only — it cannot modify the error or the response.

## Observability

Server events enable tracing, metrics, and logging without coupling to any specific observability stack. The `operation` event uses a wrapping/middleware pattern that preserves async context — so spans created inside a handler are automatically parents of any user-instrumented calls (fetch, DB clients, etc.).

```typescript
import { createServer } from "graphpc";

const server = createServer({}, (ctx) => new Api());

server.on("connection", (ctx) => console.log("connected", ctx));
server.on("disconnect", (ctx) => console.log("disconnected", ctx));
server.on("operation", async (ctx, info, execute) => {
  const start = performance.now();
  const result = await execute();
  const ms = performance.now() - start;
  console.log(
    `${info.op} ${info.path} — ${ms.toFixed(1)}ms`,
    result.error ?? "ok",
  );
  return result;
});
```

### `connection` / `disconnect`

`connection` fires when a connection opens (after the hello message is sent). `disconnect` fires when the connection closes.

```typescript
server.on("connection", (ctx) => {
  const connId = crypto.randomUUID();
  console.log(`[${connId}] connected`);
});
server.on("disconnect", (ctx) => {
  console.log("disconnected", ctx);
});
```

### `operation`

Wraps each operation (edge, get, data). The handler **must** call `execute()` exactly once and return its result. The `execute()` call runs user code (edge getters, methods, data resolution) inside the handler's async context.

When multiple `operation` handlers are registered, they compose, similar to middleware. First registered = outermost wrapper:

```typescript
server.on("operation", handlerA); // outermost
server.on("operation", handlerB); // innermost

// Execution: handlerA → handlerA calls execute() → handlerB → handlerB calls execute() → actual operation
```

`OperationInfo` fields:

| Field       | Type                        | Description                                            |
| ----------- | --------------------------- | ------------------------------------------------------ |
| `op`        | `"edge" \| "get" \| "data"` | Operation type                                         |
| `name`      | `string`                    | Edge name, method/property name, or `"data"`           |
| `path`      | `string`                    | Human-readable graph path, e.g. `root.posts.get("42")` |
| `args`      | `readonly unknown[]`        | Arguments passed to the operation                      |
| `signal`    | `AbortSignal`               | Fires on timeout or connection close                   |
| `messageId` | `number`                    | Internal message ID for correlation                    |

`OperationResult` contains `error?: unknown` — present if the operation errored, with the **original** error before redaction. This lets handlers log the real error while clients see `"Internal server error"`.

### OpenTelemetry Integration

GraphPC doesn't depend on OpenTelemetry, but the event interface is designed for it. Here's how to wire OTel spans:

```typescript
import { trace, SpanStatusCode } from "@opentelemetry/api";
import type { ServerInstance } from "graphpc";

export function addOtelTracing(server: ServerInstance<any>) {
  const tracer = trace.getTracer("graphpc");
  server.on("operation", (ctx, info, execute) => {
    return tracer.startActiveSpan(
      `graphpc ${info.path}`,
      {
        attributes: {
          "rpc.system": "graphpc",
          "rpc.method": info.name,
          "graphpc.op": info.op,
          "graphpc.path": info.path,
        },
      },
      async (span) => {
        info.signal.addEventListener(
          "abort",
          () => {
            span.addEvent("operation.aborted");
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: "aborted",
            });
          },
          { once: true },
        );

        try {
          const result = await execute();
          if (result.error) {
            span.recordException(
              result.error instanceof Error
                ? result.error
                : new Error(String(result.error)),
            );
            span.setStatus({ code: SpanStatusCode.ERROR });
          } else if (!info.signal.aborted) {
            span.setStatus({ code: SpanStatusCode.OK });
          }
          return result;
        } catch (err) {
          span.recordException(
            err instanceof Error ? err : new Error(String(err)),
          );
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        } finally {
          span.end();
        }
      },
    );
  });
}
```

Key points:

- `tracer.startActiveSpan` makes the span active during `execute()` — user-instrumented calls (fetch, DB) become child spans automatically
- `info.path` is already a human-readable string like `root.posts.get("42")` — directly usable as span names
- `info.signal` fires on timeout or connection close — the abort listener records this immediately
- Follows [OTel RPC semantic conventions](https://opentelemetry.io/docs/specs/semconv/rpc/rpc-spans/)

OTel span attributes:

| Attribute      | Value                       | Description               |
| -------------- | --------------------------- | ------------------------- |
| `rpc.system`   | `"graphpc"`                 | Identifies the RPC system |
| `rpc.method`   | `info.name`                 | Edge/method name          |
| `graphpc.op`   | `"edge"`, `"get"`, `"data"` | Operation type            |
| `graphpc.path` | `info.path`                 | Full graph path           |

## Abort Signals

Every operation has an `AbortSignal` that fires when the connection closes or the operation times out. Access it with `abortSignal()` and pass to `fetch()`, database clients, or any API that supports cooperative cancellation:

```typescript
import { abortSignal } from "graphpc";

class PostsService extends Node {
  @edge(Post, z.string())
  async get(id: string): Promise<Post> {
    const res = await fetch(`https://api.example.com/posts/${id}`, {
      signal: abortSignal(),
    });
    return new Post(await res.json());
  }

  @method(z.string())
  async search(query: string): Promise<Reference<Post>[]> {
    const rows = await db.query(
      "SELECT id FROM posts WHERE title LIKE $1",
      [query],
      {
        signal: abortSignal(),
      },
    );
    return Promise.all(rows.map((r) => ref(Post, r.id)));
  }
}
```

The signal tree:

- **Connection-wide** `AbortController` — created per connection, aborted when the transport closes.
- **Per-operation** `AbortController` — created per incoming message, chained to the connection-wide signal via `AbortSignal.any()`. Aborted when the operation times out.

`abortSignal()` returns the combined signal. It fires if either the connection drops or the individual operation exceeds `maxOperationTimeout`.

## Operation Timeout

`maxOperationTimeout` (default: 30,000ms, 0 = disabled) sets a per-operation time limit. When the timeout fires:

1. The per-operation abort signal fires
2. An `OPERATION_TIMEOUT` error is sent to the client immediately
3. For edge operations, the token is poisoned
4. The handler continues running in the background (does not release its concurrency slot until finished)

```typescript
const server = createServer(
  { maxOperationTimeout: 10_000 }, // 10 seconds per operation
  (ctx) => new Api(),
);
```

The timeout works together with abort signals — user code that checks `abortSignal()` will see the signal fire, enabling cooperative cancellation of long-running work.

## Message Size Limits

GraphPC does not set message size limits itself — that's the transport's job.

- **Bun:** Default `maxPayloadLength` is 16MB. Set via `Bun.serve({ websocket: { maxPayloadLength: 1_048_576 } })`.
- **ws:** Default `maxPayload` is 100MB. Set via `new WebSocketServer({ maxPayload: 1_048_576 })`.

Recommendation: set a reasonable limit (e.g., 1MB) to protect against oversized payloads.

## Connection Limits

| Option          | Default | Description                                      |
| --------------- | ------- | ------------------------------------------------ |
| `maxTokens`     | 9000    | Max edge traversals per connection               |
| `maxPendingOps` | 20      | Max concurrent operations executing user code    |
| `maxQueuedOps`  | 1000    | Max total in-flight messages before closing      |
| `idleTimeout`   | 5000ms  | Inactivity timeout before closing the connection |

```typescript
const server = createServer(
  {
    maxTokens: 5000,
    maxPendingOps: 10,
    maxQueuedOps: 500,
    idleTimeout: 10_000,
  },
  (ctx) => new Api(),
);
```

## Rate Limiting

### At the Upgrade Level (Recommended)

Reject connections before they open a WebSocket. This is the most efficient place to rate-limit:

```typescript
// Bun
Bun.serve({
  fetch(req, srv) {
    const ip = srv.requestIP(req)?.address;
    if (rateLimiter.isLimited(ip)) {
      return new Response("Too Many Requests", { status: 429 });
    }
    srv.upgrade(req, { data: { userId: "..." } });
  },
  websocket: server.wsHandlers((data) => data),
});

// ws
wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress;
  if (rateLimiter.isLimited(ip)) {
    ws.close(1008, "Too Many Requests");
    return;
  }
  server.handle(ws, ctx);
});
```

### In-Request Enforcement

For dynamic rate limiting (e.g., per-user limits based on context), use `getContext()` and `abortThisConn()`:

```typescript
import { getContext, abortThisConn } from "graphpc";

class Api extends Node {
  @edge(ExpensiveService)
  get expensive(): ExpensiveService {
    const ctx = getContext();
    if (!rateLimiter.allow(ctx.userId)) {
      abortThisConn(); // closes the connection
    }
    return new ExpensiveService();
  }
}
```

The existing connection limits (`maxTokens`, `maxPendingOps`, `maxQueuedOps`) provide server-side protection against abuse even without explicit rate limiting.

## Request IDs

Generate a request ID per connection and store it in context for logging:

```typescript
// Bun
Bun.serve({
  fetch(req, srv) {
    const requestId = crypto.randomUUID();
    srv.upgrade(req, { data: { requestId, userId: "..." } });
  },
  websocket: server.wsHandlers((data) => data),
});

// In your API code
const ctx = getContext();
console.log(`[${ctx.requestId}] Processing request...`);
```

## At-Least-Once Delivery

Mutations combined with reconnection may result in duplicate execution. The client is responsible for idempotency. Recommended: pass idempotency keys in method arguments for non-idempotent operations. See [Reconnection — Mutation Safety](reconnection.md#mutation-safety) for patterns.
