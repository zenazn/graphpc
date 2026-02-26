# Mental Model

When to read this page: immediately after [Getting Started](getting-started.md), before implementation details.

GraphPC treats your API as a typed object graph.

- Server: classes extending `Node`
- Client: typed stubs that mirror graph shape
- Wire: RPC only when you request data or call a method

## One Rule to Remember

Edge navigation is local. Data access is remote.

```typescript
const post = client.root.posts.get("42"); // local path build, no network
const { title } = await post; // network
await post.updateTitle("New"); // network
```

## Node Surfaces

Each node exposes three surfaces:

1. **Edges** (`@edge`)
2. **Methods** (`@method`)
3. **Data fields** (public properties + getters, including inherited ones)

### 1) Edges: graph navigation

Edges return child nodes. On the client, edge access returns another stub immediately.

```typescript
class Api extends Node {
  @edge(PostsService)
  get posts(): PostsService {
    return new PostsService();
  }
}

const posts = client.root.posts; // stub, no wire call
```

### 2) Methods: actions and computed results

Methods return data, not graph topology.

```typescript
class PostsService extends Node {
  @method
  async count(): Promise<number> {
    return 42;
  }
}

const n = await client.root.posts.count(); // always RPC
```

### 3) Data fields: node state snapshot

Public properties and getters (including inherited ones) are loaded by awaiting the node.

```typescript
class Post extends Node {
  title: string;
  body: string;

  get summary(): string {
    return this.body.slice(0, 80);
  }
}

const post = client.root.posts.get("1");
const { title, summary } = await post;
```

## Paths Are Identity

A node is identified by the [path](glossary.md#path) used to reach it.

```text
root.posts.get("42").comments
=> ["posts", ["get", "42"], "comments"]
```

That path identity enables:

- deterministic edge replay after reconnect
- SSR hydration without re-fetching everything
- references (`ref`) and path arguments (`pathOf`, `path`, `pathTo`) (see [Glossary](glossary.md))

## Caching and Ordering (Short Version)

- Same-node and same-property reads coalesce within an [epoch](glossary.md#epoch).
- Method calls do not coalesce.
- Concurrent method calls have no server-side ordering guarantee.
- Sequential `await` preserves order from the caller's perspective.

For details, see:

- [Epochs and Caching](caching.md)
- [Reconnection](reconnection.md)
- [Protocol Internals](internals.md#concurrency--ordering)

## Read This Next

1. [Decorators](decorators.md): exact behavior of `@edge`, `@method`, and `@hidden`
2. [Authentication and Authorization](auth.md): how graph reachability maps to access control
3. [Identity and References](identity.md): returning or passing node identity safely
