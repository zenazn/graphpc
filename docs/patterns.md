# Common Patterns

When to read this page: after [Authentication and Authorization](auth.md), when your API shape starts growing.

This page covers general patterns for structuring your graph. For access-control patterns, see [Authentication and Authorization](auth.md), which covers:

- [Edge Getters as Authorization Boundaries](auth.md#edge-getters-as-authorization-boundaries) — use edge getters to gate access to subgraphs based on context
- [Public vs Authenticated Subgraphs](auth.md#public-vs-authenticated-subgraphs) — serve both public and authenticated content from the same API
- [Role-Based Authorization](auth.md#role-based-authorization) — show different graphs to different roles
- [Hiding Edges with `@hidden`](auth.md#hiding-edges-with-hidden) — remove edges from the schema entirely for unauthorized users
- [Read-Only vs Writable Surfaces](auth.md#read-only-vs-writable-surfaces) — split a resource into read and write nodes with an authorizing edge between them
- [Impersonation](auth.md#impersonation) — let admins enter the graph as another user
- [Session Revocation](auth.md#session-revocation) — abort connections when sessions are invalidated

## Resource Hierarchies

Use this when your domain is parent-child by construction (orgs -> teams -> members, posts -> comments).

Real domain models are hierarchical — organizations contain teams, teams contain members, posts contain comments. Graph edges map directly to these relationships:

```typescript
class Org extends Node {
  id: string;
  name: string;

  @edge(TeamsService)
  get teams(): TeamsService {
    return new TeamsService(this.id);
  }

  @edge(OrgSettings)
  get settings(): OrgSettings {
    return new OrgSettings(this.id);
  }
}

class TeamsService extends Node {
  #orgId: string;
  constructor(orgId: string) {
    super();
    this.#orgId = orgId;
  }

  @edge(Team, z.string())
  get(id: string): Team {
    return new Team(this.#orgId, id);
  }
}
```

Each level of the hierarchy naturally scopes its children. `TeamsService` only returns teams for its org — the `#orgId` is baked in by the parent edge. No ambient context or middleware needed.

## Pagination

Use this when list endpoints need stable traversal and optional read-after-write freshness.

The simplest pagination pattern is a method that returns items and a cursor:

```typescript
@method(z.string().optional())
async list(cursor?: string): Promise<{
  items: Reference<Post>[],
  nextCursor: string | null,
}> {
  const rows = await db.posts.fetch(cursor);
  return {
    items: await Promise.all(rows.map(r => ref(Post, r.id))),
    nextCursor: rows.nextCursor,
  };
}
```

The client passes `nextCursor` back to get the next page. Each item is a reference, so the client can traverse edges and call methods on it.

### Pages as Graph Nodes

> This pattern uses references (`ref()` and `[canonicalPath]`). If you haven't read [Identity and References](identity.md) yet, start with the simple pattern above.

For richer pagination — page metadata, caching, and component-friendly data loading — model pages as graph nodes with items as a data property:

```typescript
import { canonicalPath } from "graphpc";

class PostsPage extends Node {
  cursor: string;
  total: number;
  hasNext: boolean;
  nextCursor: string | null;
  items: Reference<Post>[];

  constructor(
    cursor: string,
    total: number,
    nextCursor: string | null,
    items: Reference<Post>[],
  ) {
    super();
    this.cursor = cursor;
    this.total = total;
    this.hasNext = nextCursor != null;
    this.nextCursor = nextCursor;
    this.items = items;
  }

  static async create(cursor?: string): Promise<PostsPage> {
    const result = await db.posts.list({ after: cursor, limit: 20 });
    const items = await Promise.all(result.rows.map((r) => ref(Post, r.id)));
    return new PostsPage(result.cursor, result.total, result.nextCursor, items);
  }

  static [canonicalPath](root: Api, cursor: string) {
    return root.posts.page(cursor);
  }
}
```

Items are pre-resolved references stored as a data property. When the client awaits the page, references are serialized with their data — each item arrives ready to use with no additional wire call.

The entry point is an async edge (since constructing a page requires a DB call):

```typescript
class PostsService extends Node {
  @edge(PostsPage, z.string().optional())
  async page(cursor?: string): Promise<PostsPage> {
    return PostsPage.create(cursor);
  }
}
```

#### Client usage

```typescript
const page = client.root.posts.page();

// One await gives you everything — metadata, items, and next-page cursor
const { total, hasNext, nextCursor, items } = await page;

// Items are references — each post is navigable with data already loaded
const { title } = await items[0]; // resolves instantly from ref cache
await items[0].updateTitle("New Title"); // method call, goes over the wire

// Next page is another edge traversal using the cursor
if (nextCursor) {
  const page2 = client.root.posts.page(nextCursor);
  const { items: more } = await page2;
}
```

#### Why this works

With cursor-based pagination, a page's contents are stable — the same cursor always returns the same data. This makes items a natural fit for a data property rather than a method. Storing pre-resolved references as properties means `await page` fetches everything in one shot: metadata, items (with their data), and the next cursor.

The client navigates to the next page via `posts.page(nextCursor)` — the same edge used to load the first page. Each page is independently addressable: `posts.page("abc123")` is an ordinary edge path, so it works for deep linking, SSR, and hydration like any other node. Pages are cached by path, so revisiting a page is a cache hit. (The `[canonicalPath]` static on `Post` is what lets the page return its items as `ref()`s — it plays no role in addressing the page itself.)

Use the page-node approach when pages need caching, component integration with `use()` / `await`, or meaningful metadata (counts, facets).

## Real-Time Updates with Streams

Use `@stream` when you need to push data from the server to the client in real time — notifications, live feeds, collaborative editing cursors, etc.

```typescript
import { Node, stream } from "graphpc";
import { z } from "zod";

class NotificationsService extends Node {
  @stream(z.string().optional())
  async *updates(
    signal: AbortSignal,
    cursor?: string,
  ): AsyncGenerator<Notification> {
    let lastId = cursor;
    while (!signal.aborted) {
      const batch = await db.notifications.after(lastId, { signal });
      for (const n of batch) {
        yield n;
        lastId = n.id;
      }
      await delay(1000, signal);
    }
  }
}
```

Client usage:

```typescript
const stream = client.root.notifications.updates();

for await (const notification of stream) {
  showNotification(notification);
}
```

The cursor pattern enables resumable streams — pass the last received ID to pick up where you left off after a reconnect.

## Component Integration

GraphPC's graph-based API maps naturally to component trees. Each component receives an `RpcStub<T>` prop representing a subtree of the graph, colocating data fetching with the component that consumes it. This pattern is framework-agnostic — it works with React, Svelte, Solid, Vue, or any component model.

### The Pattern

Consider a blog app with a graph like `Api -> PostsService -> Post -> CommentsService -> Comment`. Each component takes the part of the graph it cares about:

- `<App>` receives `client.root` (`RpcStub<Api>`)
- `<PostList>` receives `RpcStub<PostsService>`, calls `.page()` to get posts
- `<PostCard>` receives one page item — an unwrapped reference, typed `RpcData<Post>`, with its data already loaded

Component boundaries align with graph boundaries. The prop type tells you exactly what a component can access — a `<PostCard>` holding `RpcData<Post>` can read `title` and `body` directly, call `updateTitle()`, and navigate to `.comments`, but it can't reach other posts or unrelated API surfaces.

### React Example

Using React 19's `use()` hook. `use()` requires a promise that stays identical across re-renders, and awaiting a stub creates a fresh promise each time — so memoize the promise; the wire message and cached data are shared either way:

```tsx
import { Suspense, use, useMemo } from "react";
import type { RpcData, RpcStub } from "graphpc/client";

function PostList({ posts }: { posts: RpcStub<PostsService> }) {
  const pagePromise = useMemo(() => posts.page().then((p) => p), [posts]);
  const { items } = use(pagePromise);

  return (
    <div>
      {items.map((item) => (
        <PostCard key={item.id} item={item} />
      ))}
    </div>
  );
}

// Page items arrive as references with data pre-loaded — plain values,
// nothing to suspend on.
function PostCard({ item }: { item: RpcData<Post> }) {
  return (
    <article>
      <h2>{item.title}</h2>
      <p>{item.body}</p>
    </article>
  );
}

// Usage
<Suspense fallback={<Loading />}>
  <PostList posts={client.root.posts} />
</Suspense>;
```

### Svelte Example

Using `await` expressions (requires `experimental.async` in your Svelte config):

```svelte
<!-- PostList.svelte -->
<script lang="ts">
  let { posts }: { posts: RpcStub<PostsService> } = $props();
  const page = posts.page();
  const { items } = await page;
</script>

{#each items as item (item.id)}
  <PostCard {item} />
{/each}

<!-- PostCard.svelte -->
<script lang="ts">
  let { item }: { item: RpcData<Post> } = $props();
</script>

<article><h2>{item.title}</h2><p>{item.body}</p></article>
```

> The [`experimental.async`](https://svelte.dev/docs/svelte/await-expressions) flag enables top-level `await` in component scripts and is expected to become stable in Svelte 6.

For reactive Svelte patterns using `$derived`, wrap stubs with `toObservable()` — see [Observable stubs](caching.md#observable-stubs).

The same pattern applies to Solid (`createResource` or `createAsync`), Vue (`async setup` + `<Suspense>`), and other component frameworks — any model that supports async data loading and component composition.

### What's Stable (and What Isn't)

GraphPC gives you two strong identities and one deliberate non-identity:

- **Stubs are stable** — `client.root.posts.get("1")` returns the same stub object on every access. No network call, no allocation churn.
- **Resolved values are stable** — awaiting the same node returns the same data proxy until it's invalidated or evicted; concurrent awaits coalesce into one wire message (see [Caching and Invalidation](caching.md#coalescing-rules)).
- **Promises are not stable** — every `await`/`.then()` on a stub creates a fresh promise object, even on a cache hit. APIs that key off promise identity (React's `use()`) need you to memoize the promise, as in the React example above, or to await in a parent/loader and pass resolved data down.

This is why edge-based pagination (pages as graph nodes) matters for this pattern: `.page()` is cached by path, so re-awaiting it is a cache hit returning the same data. A method-based `.list()` re-executes on every await — there is nothing to cache or share. See [Pages as Graph Nodes](#pages-as-graph-nodes) above.

### Coalescing and Waterfalls

The natural code style — parent awaits, renders children, children await — creates parent-to-child data waterfalls. This is the tradeoff for colocation. Here's how the system mitigates it:

- **Coalescing helps**: sibling components fetching the same node coalesce into one wire message. Ten `<PostCard>` components all awaiting posts will be pipelined.
- **References help**: page items arrive as references with data pre-loaded, so `<PostCard>` components render immediately — no additional waterfall for item data.
- **Cache lifetime**: the idle timeout won't fire during a render cycle. In-flight requests keep the connection alive, and frameworks schedule rendering back-to-back as promises resolve — there's no risk of the connection closing mid-render.

For most UIs, the waterfall depth is shallow (2-3 levels) and the user experience is good enough with Suspense fallbacks. With the page-node pattern, items arrive as references with data pre-loaded, so the first level of rendering is waterfall-free. Further edge navigation (e.g., each post loading its comments) creates the next level.

When a deeper level matters, the graph-side fix is best: put the data on the page itself (a `commentCount` data property on `Post` costs nothing extra to carry in each reference). When you can't change the graph, pre-fetch in the parent — one memoized promise covering the page and the follow-up calls:

```tsx
// Eliminates the comments waterfall by fetching counts alongside posts
function PostList({ posts }: { posts: RpcStub<PostsService> }) {
  const dataPromise = useMemo(async () => {
    const { items } = await posts.page();
    const counts = await Promise.all(
      items.map((item) => item.comments.count()),
    );
    return { items, counts };
  }, [posts]);
  const { items, counts } = use(dataPromise);

  return items.map((item, i) => (
    <PostCard key={item.id} item={item} commentCount={counts[i]} />
  ));
}
```

(Method calls are never cached, so the `count()` calls re-send whenever the memo key changes — another reason to prefer the data-property fix.)

### What References Give You

When references arrive on the client — whether from a method return or a data property like a page's `items` — each reference includes its data pre-fetched. A child component receiving one of these references can:

- **Access data without a new wire call** — `.title`, `.body` arrived with the reference. Awaiting resolves instantly from cache.
- **Call methods** — `.updateTitle()` goes over the wire as a normal method call.
- **Navigate edges** — `.comments` starts a new edge traversal, triggering its own fetch.

This means a `<PostCard>` that received a reference from a page's `items` property renders immediately — the data is already there. Only further edge navigation creates new fetches. See [Identity and References](identity.md) for the full `ref()` API.

## Read This Next

1. [Identity and References](identity.md): full behavior of `ref()` and path-based identity tools
2. [SSR and Hydration](ssr-and-hydration.md): carrying graph traversal and data across render/hydration boundaries
3. [Runtime Lifecycle and Resilience](runtime.md): how caching, invalidation, and reconnect affect UI behavior
