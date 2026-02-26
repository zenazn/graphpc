# Production Operations (Advanced)

When to read this page: after [Production Guide](production.md), when you are implementing instrumentation, cancellation, and enforcement details.

This page contains implementation-heavy patterns that were intentionally split from the baseline production guide.

## Observability

Server events enable tracing, metrics, and logging without coupling to a specific observability stack.

Use `operation` for instrumentation, not authorization. Access control belongs in graph code (`@hidden`, edge getters, and method logic).

```typescript
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

- `connection` fires when a connection opens (after hello).
- `disconnect` fires when it closes.

```typescript
server.on("connection", () => {
  const connId = crypto.randomUUID();
  console.log(`[${connId}] connected`);
});

server.on("disconnect", (ctx) => {
  console.log("disconnected", ctx);
});
```

### `operation`

`operation` wraps each edge/get/data operation. Handlers must call `execute()` exactly once and return its result.

Multiple handlers compose in registration order (first registered = outermost).

```typescript
server.on("operation", handlerA); // outermost
server.on("operation", handlerB); // inner
```

`OperationInfo` fields:

| Field       | Type                        | Description               |
| ----------- | --------------------------- | ------------------------- |
| `op`        | `"edge" \| "get" \| "data"` | Operation kind            |
| `name`      | `string`                    | Edge/member/data name     |
| `path`      | `string`                    | Human-readable graph path |
| `args`      | `readonly unknown[]`        | Operation args            |
| `signal`    | `AbortSignal`               | Aborts on timeout/close   |
| `messageId` | `number`                    | Internal correlation id   |

`OperationResult.error` (if present) contains the original server error, before redaction.

### OpenTelemetry Integration

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
            span.setStatus({ code: SpanStatusCode.ERROR, message: "aborted" });
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

## Abort Signals

Each operation gets an `AbortSignal` that fires on connection close or timeout. Use `abortSignal()` and pass it into cooperative APIs (`fetch`, database client calls, etc.).

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
      { signal: abortSignal() },
    );
    return Promise.all(rows.map((r) => ref(Post, r.id)));
  }
}
```

Signal model:

- connection-wide controller aborts when transport closes
- per-operation controller aborts when timeout triggers
- `abortSignal()` is the combined signal

## Rate Limiting

### Upgrade-Level Enforcement (Recommended)

Reject connections before opening WebSocket state.

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

For dynamic user-tier rules, enforce from graph code using context.

```typescript
import { getContext, abortThisConn } from "graphpc";

class Api extends Node {
  @edge(ExpensiveService)
  get expensive(): ExpensiveService {
    const ctx = getContext();
    if (!rateLimiter.allow(ctx.userId)) {
      abortThisConn();
    }
    return new ExpensiveService();
  }
}
```

## Request IDs

Generate an ID at upgrade time and store in context.

```typescript
// Bun
Bun.serve({
  fetch(req, srv) {
    const requestId = crypto.randomUUID();
    srv.upgrade(req, { data: { requestId, userId: "..." } });
  },
  websocket: server.wsHandlers((data) => data),
});

// In graph code
const ctx = getContext();
console.log(`[${ctx.requestId}] processing`);
```
