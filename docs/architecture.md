# Architecture

## The Object Graph

GraphPC models your API as a **typed graph of objects**. Every node class extends `Node` (from `"graphpc"`), which provides a structural brand for compile-time edge detection. The root is a single instance (e.g., `new Api()`). Edges connect nodes to children. Methods perform operations and return data.

```
Api
├── posts: PostsService
│   └── get(id): Post
│       ├── comments: CommentsService
│       └── author: User
└── users: UsersService
    └── get(id): User
```

The client navigates this graph through typed stubs. Navigation is lazy — no network call happens until the client awaits data or calls a method.

## Data Flow

### Navigation (edges)

When the client accesses an edge, it gets a stub — a local object that knows its path but holds no data. No network call happens.

```typescript
const post = client.root.posts.get("42"); // No network call. Just builds a path.
```

### Data access (properties, getters, methods)

When the client awaits a stub or calls a method, data crosses the wire:

```typescript
const { title } = await post; // Fetches all data fields (own props + getters)
const title = await post.title; // Single field, served from cache if node already loaded
await post.updateTitle("New Title"); // Calls a @method
```

Data requests execute concurrently on the server with no ordering guarantee — even for requests targeting the same node. Concurrent awaits for the same node or property are coalesced into a single wire message (see [Caching](caching.md#coalescing-rules)). Awaiting each call before issuing the next guarantees sequential execution. See [Concurrency & Ordering](internals.md#concurrency--ordering) for details.

### Public properties

A node's public properties are its **data**. These are returned by a data request:

```typescript
class User extends Node {
  name: string;     // Public — included in data
  email: string;    // Public — included in data
  #id: string;      // Private — never exposed

  @method           // Prototype method — not data
  async updateName(name: string) { ... }

  @edge(UserPosts)  // Prototype getter — not data
  get posts() { ... }
}
```

## Navigation vs Data Access

There are two fundamentally different things you can do with a node: **navigate** to a child, or **access data**.

|                  | Navigation (edges)                     | Data access                                          |
| ---------------- | -------------------------------------- | ---------------------------------------------------- |
| **What you do**  | Traverse to a child node               | Read a value or call a method                        |
| **What you get** | A stub for further navigation          | A Promise that resolves to the return value          |
| **Network**      | None — returns a local stub            | Triggers a network call; `await` collects the result |
| **Path**         | Extends the path deeper into the graph | Terminal — returns data to the caller                |

Properties and getters are returned as **data fields** by `await node`. The client doesn't distinguish between them — they're all just fields on the resolved object. `@method` calls are separate and always go over the wire.

```typescript
class UsersService extends Node {
  @edge(User, z.string())     // Navigation — client gets a stub
  get(id: string): User { ... }

  @method                      // Data access — client gets Promise<Reference<User>[]>
  async list(): Promise<Reference<User>[]> { ... }

  @method                      // Sync return also works — client gets Promise<number>
  total(): number { ... }
}

class User extends Node {
  first: string;               // Data field — included in await user
  last: string;                // Data field — included in await user
  get fullName(): string {     // Data field — also included in await user
    return `${this.first} ${this.last}`;
  }
}
```

## Paths and Node Identity

Every node is identified by the **path** used to reach it from the root:

```
root.posts.get("42").comments
→ ["posts", ["get", "42"], "comments"]
```

Each segment is either:

- A **string** — property access (getter edge): `"posts"`
- A **tuple** — method call with args: `["get", "42"]`

Paths are **durable addresses**. They can be:

- Serialized into HTML during SSR
- Stored in a database
- Replayed on any server instance with the same API definition

There is no server-side state required to resolve a path.

The server guarantees that the same path always produces the same node instance within an epoch — no duplicate objects, no repeated side effects. Edge resolution logic runs exactly once per unique path, even if multiple concurrent operations navigate to the same node. For implementation details, see [Internals](internals.md#node-coalescing).

## Connection Lifecycle (Epochs)

An **epoch** is a contiguous period of activity tied to a single WebSocket connection. All resolved data is cached within an epoch, and identical requests coalesce. When the connection closes, the epoch ends and all cached state is cleared. See [Epochs & Caching](caching.md) for the full caching model.

1. **Server setup**: Create a server with `createServer(options, (ctx) => new Api())`. The factory is called once per connection with the connection's context.
2. **Connection**: Call `server.handle(transport, ctx)` to bind a transport with request context. Each operation gets an abort signal accessible via `abortSignal()` — use it alongside `getContext()` for cooperative cancellation.
3. **SSR** _(optional)_: Components interact with real objects directly. The SSR context records traversals and data, producing the **hydration epoch** — a special epoch whose cache is pre-populated from the SSR payload.
4. **Hydration** _(optional)_: Components hydrate, running the same set of data load calls as they did on the server. Data is returned from the SSR data. No network calls are made, unless data that was not present in the SSR data is requested. The hydration epoch is still active.
5. **Hydration complete** _(optional)_: Either via an explicit `client.endHydration()` call or a period of inactivity. The hydration epoch ends.
6. **First live epoch**: Triggered on the first method call or `await` after the hydration epoch. The WebSocket opens, and requests are made. Already-traversed edges are reused automatically. All data is cached within this epoch.
7. **Epoch end**: The server closes the WebSocket when idle too long, when the token limit is reached, or when the queued ops limit is exceeded, ending the epoch and freeing all session state.
8. **Unexpected disconnect**: If the transport drops (network loss, server crash), the client auto-reconnects with exponential backoff. In-flight requests are queued and retried transparently. The client emits `'disconnect'`, `'reconnect'`, and `'reconnectFailed'` events for UI feedback. See [Reconnection](reconnection.md).
9. **Next epoch**: A new epoch begins — new WebSocket, fresh cache. The client replays edges lazily, only re-walking paths needed by pending or new requests.

The server holds session state for the duration of an epoch — typically **seconds**, not the lifetime of a page session. This is also why reconnection is lightweight — there is no long-lived server state to restore.

## Transport Is an Implementation Detail

GraphPC uses WebSockets as its transport, but the programming model is strictly **request/response**. The client asks, the server answers. There is no server push, no subscriptions, no streaming updates. WebSockets are used because they allow multiplexed, bidirectional messaging over a single connection — not because the library needs persistent channels or server-initiated communication.

This means you can reason about every interaction as a function call with a return value. The transport could change without affecting the API surface. Server push is not currently planned.
