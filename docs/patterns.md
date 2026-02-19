# Common Patterns

This page covers general patterns for structuring your graph. For access-control patterns, see [Authentication and Authorization](auth.md), which covers:

- [Edge Getters as Authorization Boundaries](auth.md#edge-getters-as-authorization-boundaries) — use edge getters to gate access to subgraphs based on context
- [Public vs Authenticated Subgraphs](auth.md#public-vs-authenticated-subgraphs) — serve both public and authenticated content from the same API
- [Role-Based Authorization](auth.md#role-based-authorization) — show different graphs to different roles
- [Hiding Edges with `@hidden`](auth.md#hiding-edges-with-hidden) — remove edges from the schema entirely for unauthorized users
- [Read-Only vs Writable Surfaces](auth.md#read-only-vs-writable-surfaces) — split a resource into read and write nodes with an authorizing edge between them
- [Impersonation](auth.md#impersonation) — let admins enter the graph as another user
- [Session Revocation](auth.md#session-revocation) — abort connections when sessions are invalidated

## Resource Hierarchies

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

### Advanced: Pages as Graph Nodes

> This pattern uses references (`ref()` and `[canonicalPath]`). If you haven't read the [References](references.md) docs yet, start with the simple pattern above.

For richer pagination — page metadata (total count, hasNext) and navigable next-page links — model pages as graph nodes:

```typescript
import { canonicalPath } from "graphpc";

class PostsPage extends Node {
  cursor: string;
  total: number;
  hasNext: boolean;

  #nextCursor: string | null;
  #rows: { id: string }[];

  constructor(
    cursor: string,
    total: number,
    nextCursor: string | null,
    rows: { id: string }[],
  ) {
    super();
    this.cursor = cursor;
    this.total = total;
    this.hasNext = nextCursor != null;
    this.#nextCursor = nextCursor;
    this.#rows = rows;
  }

  static async create(cursor?: string): Promise<PostsPage> {
    const result = await db.posts.list({ after: cursor, limit: 20 });
    return new PostsPage(
      result.cursor,
      result.total,
      result.nextCursor,
      result.rows,
    );
  }

  @method
  async items(): Promise<Reference<Post>[]> {
    return Promise.all(this.#rows.map((r) => ref(Post, r.id)));
  }

  @method
  async next(): Promise<Reference<PostsPage> | null> {
    if (!this.#nextCursor) return null;
    return ref(PostsPage, this.#nextCursor);
  }

  static [canonicalPath](root: Api, cursor: string) {
    return root.posts.page(cursor);
  }
}
```

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

// Page metadata comes from data properties
const { total, hasNext } = await page;

// Items are references — each post is navigable
const items = await page.items();
const { title } = await items[0]; // data, already available (resolves instantly from ref cache)
await items[0].updateTitle("New Title"); // method call, goes over the wire

// Next page is a reference too — or null at the end
const page2 = await page.next();
if (page2) {
  const moreItems = await page2.items();
}
```

#### Why this works

The key insight is that `next()` is a `@method`, not an `@edge`. Methods can return null — no awkward sentinel nodes or thrown errors at the end of the list. But the returned value is a `Reference<PostsPage>`, so it's still a navigable graph node with its own data, methods, and a canonical path.

Each page is addressable: the `[canonicalPath]` static method resolves `PostsPage` to a path like `root.posts.page("abc123")`. Pages are SSR-serializable, resumable across connections, and work with hydration — all from existing reference machinery.

Use the page-node approach when pages have meaningful data (counts, facets) or behavior (filtered sub-queries).

## Component Integration

GraphPC's graph-based API maps naturally to component trees. Each component receives an `RpcStub<T>` prop representing a subtree of the graph, colocating data fetching with the component that consumes it. This pattern is framework-agnostic — it works with React, Svelte, Solid, Vue, or any component model.

### The Pattern

Consider a blog app with a graph like `Api → PostsService → Post → CommentsService → Comment`. Each component takes a stub for the part of the graph it cares about:

- `<App>` receives `client.root` (`RpcStub<Api>`)
- `<PostList>` receives `RpcStub<PostsService>`, calls `.page()` to get posts
- `<PostCard>` receives `RpcStub<Post>`, awaits it for data, renders

Component boundaries align with graph boundaries. The prop type tells you exactly what data and methods a component can access — if a `<PostCard>` takes `RpcStub<Post>`, it can read `title` and `body`, call `updateTitle()`, and navigate to `.comments`, but it can't access other posts or unrelated API surfaces.

### React Example

Using React 19's `use()` hook:

```tsx
function PostList({ posts }: { posts: RpcStub<PostsService> }) {
  const page = posts.page();
  const items = use(page.items());

  return (
    <div>
      {items.map((item) => (
        <Suspense key={item.id} fallback={<Skeleton />}>
          <PostCard item={item} />
        </Suspense>
      ))}
    </div>
  );
}

function PostCard({ item }: { item: RpcStub<Post> }) {
  const { title, body } = use(item);
  return (
    <article>
      <h2>{title}</h2>
      <p>{body}</p>
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
<script>
  let { posts }: { posts: RpcStub<PostsService> } = $props();
  const page = posts.page();
  const items = await page.items();
</script>

{#each items as item (item.id)}
  <svelte:boundary>
    <PostCard {item} />
    {#snippet pending()}<Skeleton />{/snippet}
  </svelte:boundary>
{/each}

<!-- PostCard.svelte -->
<script>
  let { item }: { item: RpcStub<Post> } = $props();
  const { title, body } = await item;
</script>

<article><h2>{title}</h2><p>{body}</p></article>
```

> The [`experimental.async`](https://svelte.dev/docs/svelte/await-expressions) flag enables top-level `await` in component scripts and is expected to become stable in Svelte 6.

The same pattern applies to Solid (`createResource` or `createAsync`), Vue (`async setup` + `<Suspense>`), and other component frameworks — any model that supports async data loading and component composition.

### Promise Stability

React's `use()` and similar APIs require stable promise identity across re-renders. GraphPC provides this naturally:

- **Edge navigation is synchronous** — `client.root.posts.get("1")` always returns the same stub object. No network call, no new promise.
- **Epoch cache** — awaiting a stub returns the same promise within an epoch. Two `use(post)` calls in the same render tree share one wire message.
- **Referential stability** — stubs passed as props are stable objects. The promises they produce are stable because of coalescing (see [Epochs & Caching](caching.md#coalescing-rules)).

This is why edge-based pagination (pages as graph nodes) matters for this pattern. An edge like `.page()` returns a stable stub, while a method like `.list()` returns a new promise each call. With `use()`, you need the former. See the [Pages as Graph Nodes](#advanced-pages-as-graph-nodes) section above.

### Coalescing and Waterfalls

The natural code style — parent awaits, renders children, children await — creates parent-to-child data waterfalls. This is the tradeoff for colocation. Here's how the system mitigates it:

- **Coalescing helps**: sibling components fetching the same node coalesce into one wire message. Ten `<PostCard>` components all awaiting posts will be pipelined.
- **References help**: returned references include data, so common pagination patterns don't require an additional waterfall (see below).
- **Epoch lifetime**: the idle timeout won't fire during a render cycle. In-flight requests keep the epoch alive, and frameworks schedule rendering back-to-back as promises resolve — there's no risk of the connection closing mid-render.

For most UIs, the waterfall depth is shallow (2–3 levels) and the user experience is good enough with Suspense fallbacks. For the few performance-critical paths where it matters, pre-fetch in a parent component and pass resolved data down as props:

```tsx
// Eliminates waterfall at the cost of moving the fetch
function PostList({ posts }: { posts: RpcStub<PostsService> }) {
  const page = posts.page();
  const items = use(page.items());
  // Pre-fetch all post data in parallel
  const resolved = use(Promise.all(items.map((item) => item)));

  return resolved.map((post) => <PostCard data={post} />);
}

function PostCard({ data }: { data: { title: string; body: string } }) {
  return (
    <article>
      <h2>{data.title}</h2>
      <p>{data.body}</p>
    </article>
  );
}
```

### What References Give You

When a method returns `Reference<Post>[]`, each reference arrives on the client with its data already fetched. A child component receiving one of these references can:

- **Access data without a new wire call** — `.title`, `.body` arrived with the reference. Awaiting resolves instantly from cache.
- **Call methods** — `.updateTitle()` goes over the wire as a normal method call.
- **Navigate edges** — `.comments` starts a new edge traversal, triggering its own fetch.

This means a `<PostCard>` that received a reference from `.list()` renders immediately — the data is already there. Only further edge navigation creates new fetches. See [References](references.md) for the full `ref()` API.
