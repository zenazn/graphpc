# GraphPC — LLM Reference

GraphPC is a TypeScript RPC library where the API is a typed object graph. Think tRPC but with graph traversal instead of flat procedures, and GraphQL but without a query language. The client navigates edges synchronously (no network call), then `await`s to fetch data or call methods.

## Mental Model

```
Server: classes extending Node + decorators → typed graph
Client: Stubs → lazy navigation, await = network call
Wire: WebSocket + devalue serialization, pipelined via token machine
```

- All node classes extend `Node` (from `"graphpc"`)
- **`@edge(TargetClass, ...schemas)`** on a getter/method = graph relationship. Client gets a synchronous stub.
- **`@method(...schemas)`** on a method. Can return `T` or `Promise<T>`. Client always gets a Promise.
- **Undecorated** non-function own properties + getters = data fields. Returned together by `await node`.
- **`@hidden(predicate)`** = conditionally hide any member (edge, method, or data field) per-connection.

Navigation is lazy (no RPC). Data access (`await stub`, `await stub.prop`, `stub.method()`) triggers RPC.

## Quick Start

### Server

```ts
import { Node, edge, method, createServer, getContext } from "graphpc";
import { z } from "zod";

class Post extends Node {
  id: string;
  title: string;
  constructor(id: string) {
    super();
    const row = db.posts.get(id);
    this.id = row.id;
    this.title = row.title;
  }

  @method(z.string())
  async updateTitle(title: string): Promise<void> {
    await db.posts.update(this.id, { title });
  }
}

class PostsService extends Node {
  @edge(Post, z.string())
  get(id: string): Post {
    return new Post(id);
  }

  @method
  async count(): Promise<number> {
    return db.posts.count();
  }
}

class Api extends Node {
  @edge(PostsService)
  get posts(): PostsService {
    return new PostsService();
  }
}

const server = createServer({}, (ctx) => new Api());
Bun.serve({
  fetch(req, srv) {
    srv.upgrade(req, { data: { userId: "..." } });
  },
  websocket: server.wsHandlers<{ userId: string }>((data) => data),
});
```

### Client

```ts
import { createClient } from "graphpc/client"; // or "graphpc" — both work

const client = createClient<typeof server>(
  {},
  () => new WebSocket("ws://localhost:3000"),
);

const post = client.root.posts.get("1"); // sync, no RPC
const { id, title } = await post; // fetch all data fields
const t = await post.title; // single field (uses cache if already fetched, otherwise fetches just this field)
await post.updateTitle("New Title"); // method call
const n = await client.root.posts.count();
```

## Entry Points

- `"graphpc"` — everything (server + client). Depends on `node:async_hooks`.
- `"graphpc/client"` — client-only. No Node.js dependencies; safe for browsers and edge runtimes.

## Decorators

| Decorator                  | On              | Returns to client                              | Network     |
| -------------------------- | --------------- | ---------------------------------------------- | ----------- |
| `@edge(Class)`             | getter / method | `RpcStub<Class>`                               | None (lazy) |
| `@edge(Class, ...schemas)` | method          | `RpcStub<Class>`                               | None (lazy) |
| `@method`                  | method          | `Promise<ReturnType>`                          | On invoke   |
| `@method(...schemas)`      | method          | `Promise<ReturnType>`                          | On invoke   |
| `@hidden(ctx => bool)`     | any member      | Hides from schema and blocks access at runtime | N/A         |

Methods can return `T` or `Promise<T>` — the client always receives `Promise<T>`.

Schemas are [Standard Schema](https://standardschema.dev/) (zod, valibot, arktype, etc.). Each positional schema validates the corresponding parameter. Details: [Decorators](decorators.md).

## Auth / Context

Type context via module augmentation (`declare module "graphpc" { interface Register { context: { ... } } }`). Provide at connection time: `server.handle(transport, ctx)`. Access anywhere: `getContext()` (uses `AsyncLocalStorage`).

**Capability model**: reachability = authorization. Edge getters are auth boundaries — throw or use `@hidden` to gate access. `@hidden` removes the member from that connection's schema (not just runtime gating). Details: [Auth](auth.md).

## References

When a `@method` needs to return navigable objects (not just data), use `ref(Class, ...args)`. It returns a data+stub hybrid: the client gets all data fields immediately plus a live stub for further navigation and method calls. Each ref'd class needs a static `[canonicalPath]` method that describes how to reach it from the root. **Read-after-write**: return `ref()` from mutations so the client receives fresh data + a live stub, updating its cache automatically. Details: [References](references.md).

## Path References

Path references are lightweight navigable handles carrying only path segments (no data). Bidirectional: clients send paths as method arguments via `pathOf(stub)` + `path(Class)` schema; servers return paths as a cheaper alternative to `ref()` via `pathTo(Class, ...args)`. On the server, `await` a received `Path<T>` to walk the graph into a live node. **Security**: `path()` validates against the connection's schema (hidden edges rejected, max 64 segments). **Type mapping**: `Path<T>` params become `PathArg` on client; `Path<T>` returns become `RpcStub<T>` on client. Details: [Path References](paths.md).

## Caching / Epochs

An **epoch** is a contiguous activity period with a shared cache. Edge traversals and data fetches are cached; `@method` calls are never cached. Concurrent awaits for the same node/property coalesce into one wire message. Details: [Caching](caching.md).

## Error Handling

Built-in errors (all extend `RpcError`): `ValidationError`, `EdgeNotFoundError`, `MethodNotFoundError`, `ConnectionLostError`. `RpcError` itself is also exported for direct use. Custom errors need reducer/reviver registration on both sides. `formatPath()` and `formatValue()` produce human-readable strings for debugging. Details: [Errors](errors.md), [Serialization](serialization.md).

## Production

`abortSignal()` returns the current operation's `AbortSignal` (fires on disconnect/timeout). `maxOperationTimeout` (default: 30s) sets per-operation limits. Unregistered errors are redacted in production (`NODE_ENV=production`); every error includes a UUID (`getErrorUuid(err)`). `server.on("operationError", ...)` for logging. Server events enable tracing/metrics; multiple `operation` handlers compose as middleware. Details: [Production Guide](production.md).

## SSR & Hydration

`createSSRClient<typeof server>(root, ctx)` for server rendering; same `client.root` API as `createClient`. After rendering, `client.generateHydrationData()` serializes the snapshot. On the client, `client.hydrate(data)` or `client.hydrateString(str)` serves cached data instantly, then transitions to live. Details: [SSR](ssr-and-hydration.md).

## Reconnection

If the transport drops while idle, the client waits until the next operation and opens a fresh connection. If in-flight operations exist, it reconnects eagerly with exponential backoff. In-flight promises survive disconnects. New epoch on reconnect. After retry exhaustion, new operations reject with `ConnectionLostError`; call `client.reconnect()` to reset retries and try again. Mutations are at-least-once — use idempotency keys for non-idempotent ones. Disable with `reconnect: false`. Details: [Reconnection](reconnection.md).

## Testing

`mockConnect(server, ctx)` returns a client-side transport wired to the server — use as the factory in `createClient`. For raw wire-level testing, use `createMockTransportPair()`. Details: [Testing](testing.md).

## Type System

`client.root` is `RpcStub<Api>`. All node classes extend `Node`, which gives the type system a structural brand to detect edges:

- Function returning `T extends Node` → sync edge → `RpcStub<T>`
- Function returning `Promise<T>` where `T extends Node` → async edge → `RpcStub<T>`
- Function returning `T` or `Promise<T>` where `T` is not `Node` → method → `Promise<T>`
- Non-function property whose type extends `Node` → property edge → `RpcStub<T>`
- `await stub` → data fields + stubs for edges/methods
- `Reference<T>` in method returns → unwrapped to data+stub hybrid
- `Path<T>` in method params → `PathArg` on client; in method returns → `RpcStub<T>` on client

No codegen. Types flow via `createClient<typeof server>`. Details: [Type Safety](type-safety.md), [Type Checking](type-checking.md).
