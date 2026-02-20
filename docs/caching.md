# Epochs & Caching

## Overview

The client organizes activity into **epochs**. An epoch is a contiguous period of activity tied to a single WebSocket connection. All resolved data is cached within an epoch, and identical requests coalesce into a single wire message.

An epoch starts when the client first needs data (opening a WebSocket), stays alive while there are in-flight or new requests, and ends after a configurable period of inactivity. When an epoch ends, the connection closes and all cached state is cleared. The next `await` opens a fresh connection, starting a new epoch.

## Epoch Lifecycle

An epoch has three phases:

1. **Start** — the first `await` that needs the wire opens a WebSocket and begins the epoch
2. **Active** — every request resets the inactivity timer; in-flight requests keep the epoch alive
3. **End** — when no requests are outstanding for the configured `idleTimeout`, the server closes the WebSocket (clearing server-side tokens) and the client drops its cache

The next `await` after an epoch ends opens a fresh connection — a new epoch with an empty cache.

```typescript
// --- Epoch 1 starts: first await opens the WebSocket ---

const post = client.root.posts.get("1");
const { title } = await post; // sends edge + data messages
console.log(title); // "Hello World"

// Cache hit: same node, same epoch — no wire message
const { title: t2 } = await post;
console.log(t2); // "Hello World" (from cache)

// ... idleTimeout elapses, server closes connection, epoch 1 ends ...

// --- Epoch 2 starts: next await opens a new WebSocket ---

const { title: t3 } = await post; // fresh edge + data messages
console.log(t3); // reflects current server state
```

## Coalescing Rules

Within an epoch, the client coalesces and caches requests according to three rules.

### 1. Same node loads coalesce

Two requests for the same node produce one `data` message, whether they're concurrent or sequential within the epoch:

```typescript
// Concurrent — one data message, both resolve to the same object
const [a, b] = await Promise.all([
  client.root.posts.get("1"),
  client.root.posts.get("1"),
]);
```

```typescript
// Sequential — still one data message (second is a cache hit)
const a = await client.root.posts.get("1");
const b = await client.root.posts.get("1"); // served from epoch cache
```

### 2. Same property/getter reads coalesce

Two reads of the same property on the same node produce one `get` message:

```typescript
// Concurrent — one wire message for .title
const [t1, t2] = await Promise.all([
  client.root.posts.get("1").title,
  client.root.posts.get("1").title,
]);

// Sequential — second is a cache hit
const t1 = await client.root.posts.get("1").title;
const t2 = await client.root.posts.get("1").title; // from cache
```

### 3. Methods never coalesce

Every method call sends an independent `get` message, even if the same method is called with the same arguments. Methods may have side effects, so caching would be incorrect.

```typescript
const [a, b] = await Promise.all([
  client.root.posts.get("1").addComment("Great!"), // independent message
  client.root.posts.get("1").addComment("Thanks!"), // independent message
]);
```

## What Gets Cached

| Operation                                 | Cached within epoch? | Cache key                        |
| ----------------------------------------- | -------------------- | -------------------------------- |
| Edge traversal (`client.root.posts`)      | Yes                  | path                             |
| Full-node load (`await node`)             | Yes                  | token                            |
| Property/getter read (`await node.title`) | Yes                  | token + name, or from data cache |
| Method call (`node.method(...)`)          | Never                | —                                |

After `await node`, subsequent property reads like `await node.title` are served from the data cache — no additional wire message is sent. Method calls (`node.method()`) always go over the wire.

### Cache key identity

Cache keys for edge traversals are built by serializing each path segment with devalue. Devalue does **not** sort object keys — it preserves JavaScript's property enumeration order (integer keys ascending, then string keys in insertion order). Two object literals with the same entries in different order produce different cache keys:

```typescript
// These are two different cache keys — they will NOT coalesce
client.root.posts.search({ author: "alice", limit: 10 });
client.root.posts.search({ limit: 10, author: "alice" });
```

This is rarely an issue in practice (arguments typically come from a single code path), but if you build argument objects dynamically, be aware that insertion order matters. Note that this behavior is an implementation detail, not a guarantee — a future version of GraphPC may normalize key order so that the two calls above do coalesce.

## Read-After-Write

Because data is cached within an epoch, a plain `await node` after a mutation returns **cached** (potentially stale) data:

```typescript
const post = client.root.posts.get("1");
const { title } = await post; // "Hello World" — cached

await post.updateTitle("New Title"); // mutation executes on server
const { title: after } = await post; // "Hello World" — stale cache hit!
```

To keep the cache fresh, mutations should return a `ref()` to the mutated node. On the server, `ref()` always re-resolves the target node (bypassing the per-request node cache), so the reference carries data from after the mutation. On the client, the arriving reference overwrites the data cache for that node — subsequent `await node` and `await node.title` calls return the updated data instead of a stale cache hit.

Edges that descend from the ref'd node are also invalidated — cached nodes below the ref path are invalidated so subsequent traversals re-resolve from the fresh node. The node's data cache is overwritten with the ref's fresh data, and per-property caches are invalidated (subsequent reads are served from the fresh data, not from stale per-property caches).

```typescript
// Server — return a ref to the mutated node
class Post extends Node {
  @method(z.string())
  async updateTitle(title: string): Promise<Reference<Post>> {
    this.title = title;
    return ref(Post, this.id);
  }
}

// Client — ref overwrites cache, keeping subsequent reads fresh
const post = client.root.posts.get("1");

const { title } = await post; // "Hello World"
const t1 = await post.title; // "Hello World" (cached get)

const updated = await post.updateTitle("New Title"); // returns ref → overwrites cache
console.log(updated.title); // "New Title" — fresh from the ref

const { title: after } = await post; // "New Title" — cache was overwritten
const t2 = await post.title; // "New Title" — get cache was invalidated
```

This makes `ref()` the primary mechanism for keeping client-side state fresh after mutations. See [References](references.md) for the full `ref()` API.

## The Hydration Epoch

SSR hydration uses a special kind of epoch. Its cache is pre-populated from the server-rendered payload rather than from wire responses, it uses a shorter inactivity timeout, and it requires no WebSocket. It also caches `@method` call results — matched by path and arguments — and replays them during client hydration. Live epochs never cache method calls.

|                      | Hydration epoch              | Live epoch                           |
| -------------------- | ---------------------------- | ------------------------------------ |
| **Data source**      | SSR payload (`window.__rpc`) | WebSocket responses                  |
| **Default timeout**  | 250ms (client-side)          | Server's `idleTimeout` (server-side) |
| **Transport needed** | No                           | Yes                                  |
| **Methods cached**   | Yes (SSR-recorded results)   | Never                                |
| **Ends when**        | `endHydration()` or timeout  | Idle timeout closes WebSocket        |

When the hydration epoch ends, all cached data is dropped. The next cache miss triggers a WebSocket connection, starting a live epoch. See [SSR & Hydration](ssr-and-hydration.md) for how the payload is generated and consumed.

## Configuration

**Server** — `idleTimeout` controls how long a connection stays open after the last request completes:

```typescript
const server = createServer(
  { idleTimeout: 10_000 }, // 10 seconds of inactivity → close (default: 5s)
  (ctx) => new Api(),
);
```

**Client** — `hydrationTimeout` controls how long the hydration epoch lasts after the last cache hit:

```typescript
const client = createClient<typeof server>(
  { hydrationTimeout: 500 }, // 500ms hydration window
  () => new WebSocket("ws://localhost:3000"),
);
client.hydrate(window.__rpc);
```
