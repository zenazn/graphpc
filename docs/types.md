# Types and Type Checking

When to read this page: when client types or autocomplete do not match your expected GraphPC runtime behavior.

## Core Model: `RpcStub<T>`

`RpcStub<T>` maps server node classes to client stub types. Types flow from `createClient<typeof server>(...)`; no codegen is required.

```typescript
import { createServer, createMockTransportPair } from "graphpc";
import { createClient } from "graphpc/client";

const [serverTransport, clientTransport] = createMockTransportPair();
const server = createServer({}, () => new Api());
server.handle(serverTransport, {});

const client = createClient<typeof server>({}, () => clientTransport);
// client.root is RpcStub<Api>
```

## Mapping Rules

### Edges map to synchronous stubs

Functions/getters returning `Node` subclasses become synchronous traversal on the client.

```typescript
class Api extends Node {
  @edge(PostsService)
  get posts(): PostsService { ... }
}

client.root.posts; // RpcStub<PostsService>
```

Async edges (`Promise<T extends Node>`) also map to synchronous stubs.

### `@method` maps to `Promise<...>`

Functions returning non-node data always map to async RPC calls.

```typescript
class PostsService extends Node {
  @method
  count(): number { ... }
}

client.root.posts.count(); // Promise<number>
```

### `@stream` maps to `RpcStream<T>`

Async generator functions decorated with `@stream` map to `RpcStream<T>` on the client — an async iterable that yields values as the server produces them.

```typescript
class NotificationsService extends Node {
  @stream
  async *updates(signal: AbortSignal): AsyncGenerator<Notification> { ... }
}

client.root.notifications.updates(); // RpcStream<Notification>
```

### `await stub` returns data + stubs

Awaiting a stub fetches node data fields and still exposes edge/method stubs.

```typescript
const user = client.root.users.get("42");
const data = await user;
data.name; // data field
await data.save(); // method call still works
```

## Why `extends Node` Is Required

Decorators do not change TypeScript types. `Node` provides the type brand that lets GraphPC distinguish:

- edge (returns `T extends Node`) vs
- method (returns data)

Without `extends Node`, `Promise<Post>` is ambiguous and inference degrades.

Quick checks when types look wrong:

- every edge target class extends `Node`
- callable RPC members are decorated (`@edge`, `@method`, or `@stream`)
- enable lint rule `graphpc/require-decorator`

## Path and Reference Type Mapping

When methods use identity tools:

- `Path<T>` parameter on server -> `PathArg` on client
- `Path<T>` return type on server -> `RpcStub<T>` on client
- `Reference<T>` return type on server -> data+stub hybrid on client

```typescript
@method(path(Post))
async archive(post: Path<Post>): Promise<void> { ... }

// Client expects PathArg
await client.root.posts.archive(pathOf(client.root.posts.get("1")));
```

See [Identity and References](identity.md) for runtime behavior.

## Stream Type Mapping

`RpcStream<T>` is the client-side type for server `@stream` declarations. It is an async iterable:

```typescript
// Server
@stream(z.string())
async *events(signal: AbortSignal, channel: string): AsyncGenerator<Event> { ... }

// Client
const stream: RpcStream<Event> = client.root.events("my-channel");
for await (const event of stream) {
  // event is typed as Event
}
```

## Shallow Return-Type Guard

Methods cannot return bare nodes in containers (`Promise<Post[]>`, `Map<string, Post>`, etc.). These are pass-by-reference objects and are not wire-serializable as plain method data.

Use `Reference<T>` instead:

```typescript
class GoodService extends Node {
  @method
  async listPosts(): Promise<Reference<Post>[]> {
    return Promise.all(posts.map((p) => ref(Post, p.id)));
  }
}
```

## ESLint Plugin

For decorator/autocomplete drift, use GraphPC's ESLint plugin.

### Setup (flat config)

```js
// eslint.config.js
import graphpc from "graphpc/eslint";

export default [
  graphpc.configs.recommended,
  // ...your configs
];
```

### Rule: `graphpc/require-decorator`

Flags public methods on `Node` subclasses that are missing `@edge`, `@method`, or `@stream`.

Skipped by rule design: constructors, getters/setters, static methods, private/protected methods, `#private` methods.

Known limitation: detects direct `extends Node`, not transitive inheritance chains.
