# GraphPC — LLM Reference

When to read this page: when generating GraphPC code/prompts and you want a compact ruleset.

Use this as a cheatsheet. Canonical behavior lives in linked docs.

## Core Rules

- All graph classes extend `Node`.
- `@edge(...)` defines navigation. Client traversal is synchronous (no immediate network call).
- `@method(...)` defines RPC calls. Client calls always return Promises.
- `@stream(...)` defines server-push async generators. Client receives `RpcStream<T>`.
- `await stub` fetches node data fields (public properties + getters, including inherited ones).
- `@hidden(predicate)` removes members from that connection's schema and blocks runtime access.

## Minimal Shape

```ts
import { Node, edge, method, stream, createServer } from "graphpc";
import { createClient, invalidate, evict, subscribe } from "graphpc/client";
import { z } from "zod";

class Post extends Node {
  @method(z.string())
  async rename(title: string): Promise<void> {}
}

class Api extends Node {
  @edge(Post, z.string())
  post(id: string): Post {
    return new Post();
  }
}

const server = createServer({}, () => new Api());
const client = createClient<typeof server>({}, () => new WebSocket("ws://..."));

const p = client.root.post("42"); // sync edge traversal
await p.rename("New"); // RPC
```

## Decorator Decision Table

| Server member type                | Decorator  | Client type     |
| --------------------------------- | ---------- | --------------- |
| returns `T extends Node`          | `@edge(T)` | `RpcStub<T>`    |
| returns `Promise<T extends Node>` | `@edge(T)` | `RpcStub<T>`    |
| returns non-node data             | `@method`  | `Promise<Data>` |
| yields server-push data feed      | `@stream`  | `RpcStream<T>`  |

Schemas use Standard Schema (zod/valibot/arktype/etc.) and validate positional params.

## Identity Tools (`identity.md`)

- `ref(Class, ...args)` -> server-to-client data + navigable stub (`Reference<T>` behavior)
- `pathOf(stub)` + `path(Class)` -> client-to-server node identity arguments
- `pathTo(Class, ...args)` -> server-to-client cheap navigable handles (no bundled data)

Use `ref()` for read-after-write freshness. Use path tools when you only need identity.

## Runtime Model (`runtime.md`)

- Client maintains a persistent cache that survives reconnects (referential identity preserved).
- Reads coalesce/cache within the persistent cache.
- `@method` calls never coalesce.
- Server uses a sliding token window for resource management.
- Use `invalidate(stub)` to mark cached data stale, `evict(stub)` to remove it.
- Use `subscribe(stub)` for reactivity (Svelte store contract).
- Hydration seeds the persistent cache; method call results are dropped after hydration.

Details: [Caching and Invalidation](caching.md), [SSR and Hydration](ssr-and-hydration.md), [Reconnection](reconnection.md).

## Auth and Context (`auth.md`)

- Provide context at connection time (`server.handle(..., ctx)`).
- Read context with `getContext()`.
- Capability model: reachability = authorization.
- Put boundary checks on edges; use `@hidden` for schema-level visibility control.

## Errors (`errors.md`)

Built-ins extend `RpcError`: `ValidationError`, `EdgeNotFoundError`, `MethodNotFoundError`, `ConnectionLostError`, `TokenExpiredError`, `StreamLimitExceededError`.

- Registered custom errors preserve `instanceof` across the wire.
- Unregistered errors arrive as `RpcError`.
- Use `getErrorUuid(err)` on the client for support correlation.

Operational policy (redaction/reporting): [Production Guide](production.md).

## Production (`production.md`)

- Set limits: `tokenWindow`, `maxStreams`, `maxPendingOps`, `maxQueuedOps`, payload size.
- Set `maxOperationTimeout`; use `abortSignal()` in long-running work.
- Log `operationError` with `errorId`.
- Use `connection` / `disconnect` / `operation` events for observability.
- Implementation-heavy observability/cancellation/rate-limit examples: [Production Operations (Advanced)](production-operations.md).

## SSR and Hydration (`ssr-and-hydration.md`)

- Server: `createSSRClient<typeof server>(root, ctx)`.
- Serialize: `client.generateHydrationData()`.
- Client: `client.hydrate(data)` or `client.hydrateString(str)` before awaits.

## Reconnection (`reconnection.md`)

- Enabled by default (disable with `reconnect: false`).
- Idle disconnect -> lazy reconnect (next operation).
- In-flight disconnect -> eager reconnect + replay.
- Persistent cache survives reconnects (same nodes, same promises).
- Delivery for in-flight mutations is at-least-once; use idempotency keys.
- Streams: without resume callback, stream ends on disconnect; with resume callback, stream continues transparently.

## Testing (`testing.md`)

- `mockConnect(server, ctx)` for e2e-style tests without real sockets.
- `createMockTransportPair()` for protocol-level tests.

## Types (`types.md`)

- No codegen. Types flow from `createClient<typeof server>`.
- `Path<T>` params map to `PathArg` client-side.
- `Reference<T>` method returns unwrap to data+stub hybrids client-side.
- `RpcStream<T>` maps `@stream` generators to async iterables on the client.
