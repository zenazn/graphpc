# Caching and Invalidation

When to read this page: after [Mental Model](mental-model.md), when you need exact cache/coalescing/read-after-write behavior.

## Overview

This page focuses on client-side cache semantics.

For the full runtime timeline (SSR -> hydration -> persistent cache -> reconnect), see [Runtime Lifecycle and Resilience](runtime.md).

The client maintains a **persistent cache** that survives reconnects:

- first `await` that needs the server opens a connection
- cached data persists across connection drops and reconnects
- referential identity is preserved (same stub objects, same promises)
- freshness is managed via `invalidate()`, `evict()`, and `ref()` returns

## Coalescing Rules

The client coalesces and caches requests according to three rules.

### 1. Same node loads coalesce

Two requests for the same node produce one `data` message, whether they're concurrent or sequential:

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
const b = await client.root.posts.get("1"); // served from cache
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

Exception: during SSR and hydration, method calls coalesce. See below.

## What Gets Cached

| Operation                                 | Cached? | Cache key                        |
| ----------------------------------------- | ------- | -------------------------------- |
| Edge traversal (`client.root.posts`)      | Yes     | path                             |
| Full-node load (`await node`)             | Yes     | token                            |
| Property/getter read (`await node.title`) | Yes     | token + name, or from data cache |
| Method call (`node.method(...)`)          | Never   | —                                |

After `await node`, subsequent property reads like `await node.title` are served from the data cache — no additional wire message is sent. Method calls (`node.method()`) always go over the wire.

### Cache key identity

Cache keys for edge traversals are built by serializing each path segment with devalue. Devalue does **not** sort object keys — it preserves JavaScript's property enumeration order (integer keys ascending, then string keys in insertion order). Two object literals with the same entries in different order produce different cache keys:

```typescript
// These are two different cache keys — they will NOT coalesce
client.root.posts.search({ author: "alice", limit: 10 });
client.root.posts.search({ limit: 10, author: "alice" });
```

This is rarely an issue in practice (arguments typically come from a single code path), but if you build argument objects dynamically, be aware that insertion order matters. Note that this behavior is an implementation detail, not a guarantee — a future version of GraphPC may normalize key order so that the two calls above do coalesce.

## Invalidation

Use `invalidate(stub)` to mark a cached node's data as stale. The next `await` on that stub will re-fetch from the server instead of returning cached data.

```typescript
import { invalidate } from "graphpc/client";

const post = client.root.posts.get("1");
const { title } = await post; // fetched from server, cached

await post.updateTitle("New Title"); // mutation
invalidate(post); // mark cache stale

const { title: after } = await post; // re-fetched from server
```

`invalidate()` does not remove the cached data immediately — it marks it stale so the next read triggers a fresh fetch. In-flight reads are not affected.

### Streams survive invalidation

Streams survive invalidation. A running stream is a source of data, not cached data. When a node is invalidated, any active stream on that node continues running. Invalidation marks the node's data as stale and notifies observers, but the async generator keeps yielding.

## Eviction

Use `evict(stub)` to remove a node's cached data entirely. This is useful when you know a node has been deleted or is no longer relevant.

```typescript
import { evict } from "graphpc/client";

const post = client.root.posts.get("1");
await post.delete();
evict(post); // remove from cache entirely
```

## Reactivity with `subscribe()`

Use `subscribe(stub, callback)` for reactive updates. The callback fires synchronously with the current stub, then again on each invalidation. Returns an unsubscribe function.

```typescript
import { subscribe } from "graphpc/client";

const post = client.root.posts.get("1");

const unsubscribe = subscribe(post, (stub) => {
  console.log("Post changed, re-derive:", stub);
});

// Later:
unsubscribe();
```

The callback value is the stub itself (which does not change). The notification is the trigger for re-derivation -- the subscriber should re-read data from the stub.

### Invalidation propagation

Invalidating a path notifies:

1. The target path's subscribers
2. All descendant paths' subscribers
3. All ancestor paths' subscribers, up to and including root

### Root vs subtree subscriptions

Root-level subscriptions are coarse -- they fire on any invalidation in the tree. Fine-grained subscriptions (e.g., on a specific post stub rather than the root) fire only when that specific subtree is invalidated. Prefer fine-grained subscriptions for performance.

### Observable stubs

`toObservable(stub)` wraps a stub so that it satisfies the [Svelte store contract](https://svelte.dev/docs/svelte/stores) and the [TC39 Observable](https://github.com/tc39/proposal-observable) / RxJS protocol. The wrapper adds:

- `.subscribe(callback)` — calls `callback` synchronously with the observable stub, re-calls on invalidation. The return value is callable (Svelte convention) and has `.unsubscribe()` (RxJS convention).
- `Symbol.observable` — returns self (RxJS `from()` interop).

Observable behavior **propagates**: child stubs accessed from an observable are also observable, so you can pass subtrees to child components without re-wrapping.

```typescript
import { toObservable, toStub } from "graphpc/client";

const obs = toObservable(client.root);
obs.posts(4); // also observable — propagation

toStub(obs); // back to raw stub
```

**Name collision**: the `.subscribe()` added by `toObservable` shadows any API edge or method named `subscribe`. If your graph has a `subscribe` member, call `toStub(obs)` first to unwrap back to the raw stub, then access it normally.

### Framework examples

**Svelte** — observable stubs work with Svelte 5's observable support:

```svelte
<script lang="ts">
  import { toObservable } from "graphpc/client";
  let { root }: { root: RpcStub<Api> } = $props();
  const oRoot = toObservable(root);
  const likes = $derived(await $oRoot.posts(4).likes);
</script>
```

When `root.posts(4)` is invalidated, the `$oRoot` subscription fires, `$derived` re-evaluates the async expression, and the `await` returns fresh data because the cache was marked stale.

**React** — use `subscribe()` directly with `useSyncExternalStore`:

```tsx
import { subscribe } from "graphpc/client";
import { useSyncExternalStore } from "react";

function useSubscribe(stub: RpcStub<any>) {
  return useSyncExternalStore(
    (cb) => subscribe(stub, cb),
    () => stub,
  );
}
```

## Read-After-Write

Because data is cached, a plain `await node` after a mutation returns **cached** (potentially stale) data:

```typescript
const post = client.root.posts.get("1");
const { title } = await post; // "Hello World" — cached

await post.updateTitle("New Title"); // mutation executes on server
const { title: after } = await post; // "Hello World" — stale cache hit!
```

To keep the cache fresh, mutations should return a `ref()` to the mutated node. On the server, `ref()` always re-resolves the target node (bypassing the per-request node cache), so the reference carries post-mutation data.

On the client, the arriving reference:

- overwrites the node data cache at the canonical path
- invalidates per-property read cache entries for that node
- invalidates cached descendants below that node so future traversals re-resolve

Result: subsequent `await node` and `await node.title` calls see fresh data.

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

const updated = await post.updateTitle("New Title"); // returns ref -> overwrites cache
console.log(updated.title); // "New Title" — fresh from the ref

const { title: after } = await post; // "New Title" — cache was overwritten
const t2 = await post.title; // "New Title" — get cache was invalidated
```

This makes `ref()` the primary mechanism for keeping client-side state fresh after mutations. See [Identity and References](identity.md) for the full `ref()` API.

Alternatively, use `invalidate(stub)` after a mutation if you don't need immediate fresh data from the return value.

## Hydration

Hydration seeds the persistent cache with SSR payload data. During the hydration phase:

- Edge traversals and node data from SSR are loaded into the persistent cache
- SSR-recorded `@method` call results are available during hydration only
- After hydration ends (`endHydration()` or timeout), method call results are dropped — all other data stays in the persistent cache

|                      | Hydration phase              | Live                                 |
| -------------------- | ---------------------------- | ------------------------------------ |
| **Data source**      | SSR payload (`window.__rpc`) | WebSocket responses                  |
| **Default timeout**  | 250ms (client-side)          | Server's `idleTimeout` (server-side) |
| **Transport needed** | No                           | Yes                                  |
| **Methods cached**   | Yes (SSR-recorded results)   | Never                                |
| **Ends when**        | `endHydration()` or timeout  | Connection closes                    |

When hydration ends, the next cache miss triggers a WebSocket connection. See [SSR and Hydration](ssr-and-hydration.md) for how the payload is generated and consumed.

## Configuration

**Server** — `idleTimeout` controls how long a connection stays open after the last request completes:

```typescript
const server = createServer(
  { idleTimeout: 120_000 }, // 2 minutes of inactivity -> close (default: 60s)
  (ctx) => new Api(),
);
```

**Client** — `hydrationTimeout` controls how long the hydration phase lasts after the last cache hit:

```typescript
const client = createClient<typeof server>(
  { hydrationTimeout: 500 }, // 500ms hydration window
  () => new WebSocket("ws://localhost:3000"),
);
client.hydrate(window.__rpc);
```

For guidance on choosing values, see [Production Guide](production.md).
