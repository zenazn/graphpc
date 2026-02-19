# References

## The Problem

By default, `@method` calls return plain data. But sometimes a method needs to return objects that the client can interact with — call methods on, traverse edges from, or await for fresh data. For example, a `list()` method that returns posts should give the client navigable post objects, not just raw data.

That's what references are for.

## When You Need References

**Rule of thumb:**

- `@edge` return values → no `ref()` needed (the edge itself creates the navigable connection)
- `@method` returns plain data → no `ref()` needed
- `@method` returns objects the client should interact with → use `ref()`

Every class whose instances you pass to `ref()` needs a `[canonicalPath]` static method (explained below). Classes that only appear as direct edge return values don't need one.

## `ref()` — Creating References

Call `ref(Class, ...args)` to create a **reference** to an instance. References are serialized with both data and their canonical path, allowing the client to interact with them as navigable proxies:

```typescript
import { Node, ref, Reference, method } from "graphpc";

class PostsService extends Node {
  @method
  async list(): Promise<Reference<Post>[]> {
    const rows = await db.posts.findMany();
    return Promise.all(rows.map((r) => ref(Post, r.id)));
  }
}
```

`ref()` is **async**. It resolves the canonical path, walks the graph to extract data, and returns a `Reference` containing both the path and the data.

## `[canonicalPath]` — Declaring Canonical Paths

A static `[canonicalPath]` method on a class declares how to reach instances of that class from the root of the graph. Import the `canonicalPath` symbol from graphpc:

```typescript
import { Node, canonicalPath } from "graphpc";

class Post extends Node {
  id: string;
  title: string;
  authorId: string;

  constructor(id: string, title: string, authorId: string) {
    super();
    this.id = id;
    this.title = title;
    this.authorId = authorId;
  }

  static [canonicalPath](root: Api, id: string) {
    return root.posts.get(id);
  }
}
```

The expression `root.posts.get(id)` tells GraphPC how to navigate from the API root to any `Post` instance. When you call `ref(Post, "42")`, GraphPC invokes this method to build the path `root.posts.get("42")`.

## Multi-Hop Paths

`[canonicalPath]` supports arbitrarily deep paths:

```typescript
class Comment extends Node {
  id: string;
  postId: string;

  constructor(id: string, postId: string) {
    super();
    this.id = id;
    this.postId = postId;
  }

  static [canonicalPath](root: Api, id: string, postId: string) {
    return root.posts.get(postId).comments.get(id);
  }
}
```

The first argument (`root`) is a recording proxy that captures the path expression. The remaining arguments are normal values. Multi-hop paths like `root.posts.get(postId).comments.get(id)` work naturally.

## Conditional Paths

Since `[canonicalPath]` methods are ordinary code, conditional resolution works naturally:

```typescript
class Content extends Node {
  id: string;
  type: "post" | "article";

  constructor(id: string, type: "post" | "article") {
    super();
    this.id = id;
    this.type = type;
  }

  static [canonicalPath](root: Api, id: string, type: "post" | "article") {
    if (type === "post") return root.posts.get(id);
    if (type === "article") return root.articles.get(id);
    throw new Error(`Unknown content type: ${type}`);
  }
}
```

## Client Usage

On the client, each reference arrives as a data+stub hybrid — data is already loaded, and methods are still callable:

```typescript
const posts = await client.root.posts.list();
posts[0].title; // data, already available
await posts[0].like(); // method call, goes over the wire
```

From the client's perspective, references look and feel like navigated edges — it doesn't matter whether a node was reached via an edge or a reference.

## Where References Can Appear

`ref()` can appear anywhere in a method's return value:

```typescript
// In arrays
async list(): Promise<Reference<Post>[]> { ... }

// In objects
async getThread(): Promise<{ post: Reference<Post>, replies: Reference<Post>[] }> { ... }

// Nested
async getFeed(): Promise<{ items: Array<{ author: Reference<User>, post: Reference<Post> }> }> { ... }
```

The serialization layer recursively walks the return value and resolves all `Reference` instances.

## References and Caching

When a reference arrives on the client (as part of a method's return value), it updates the epoch cache:

- **Node-load cache overwrite** — the ref's data replaces the cached entry at its canonical path. A subsequent `await node` returns the ref's fresh data instead of a stale cache hit.
- **Property read invalidation** — cached property-read results for that node (e.g. `await node.title`) are cleared, so the next read sends a fresh wire message.
- **Edges unaffected** — edge tokens for that node remain valid. Only the node's data and property caches are refreshed.

This makes references the primary mechanism for keeping client-side state fresh after mutations. A mutation that returns references gives the caller immediate access to updated data _and_ ensures that any code re-reading the same node within the epoch sees the update too.

For the full caching model — epochs, coalescing rules, and the hydration epoch — see [Epochs & Caching](caching.md).

## References and Authorization

`ref()` walks the **real** graph to extract data. Every edge along the canonical path is traversed, and edge getters are authorization boundaries. If the current connection's context lacks permission to traverse any edge in the path, that edge throws, the ref fails, and no data is returned.

```typescript
class Post extends Node {
  // ...
  static [canonicalPath](root: Api, id: string) {
    return root.me.posts.get(id);
    //          ^^ requires authentication
  }
}

class FeedService extends Node {
  @method
  async popular(): Promise<Reference<Post>[]> {
    const rows = await db.posts.popular();
    // If the caller isn't authenticated, ref() fails here —
    // walking root.me throws Unauthorized
    return Promise.all(rows.map((r) => ref(Post, r.id)));
  }
}
```

This is the same capability model described in [Authentication and Authorization](auth.md): if you can't reach it, you can't use it. References don't bypass authorization — they go through the same edges a client would traverse manually.

In practice, this means canonical paths should only traverse edges the caller is expected to have access to. If a method is reachable by unauthenticated clients, its refs should use canonical paths through public edges:

```typescript
class Post extends Node {
  static [canonicalPath](root: Api, id: string) {
    return root.posts.get(id); // public edge — any caller can reach this
  }
}
```

## Error Cases

### Missing `[canonicalPath]`

If you call `ref(Class, ...)` but the class doesn't have a `[canonicalPath]` method, it's a **runtime error**:

```
Error: Class Comment does not have a [canonicalPath] method
```

### Invalid Recording

If a `[canonicalPath]` method doesn't return a recording proxy result (e.g., returns a plain value), it's a runtime error:

```
Error: [canonicalPath] for Post did not return a recorded proxy
```

## Complete Example

```typescript
import { Node, edge, method, ref, Reference, canonicalPath } from "graphpc";
import { z } from "zod";

class User extends Node {
  id: string;
  name: string;
  constructor(id: string, name: string) {
    super();
    this.id = id;
    this.name = name;
  }

  static [canonicalPath](root: Api, id: string) {
    return root.users.get(id);
  }
}

class Post extends Node {
  id: string;
  title: string;
  authorId: string;
  constructor(id: string, title: string, authorId: string) {
    super();
    this.id = id;
    this.title = title;
    this.authorId = authorId;
  }

  static [canonicalPath](root: Api, id: string) {
    return root.posts.get(id);
  }
}

class PostsService extends Node {
  @edge(Post, z.string())
  get(id: string): Post {
    const row = db.posts.find(id);
    return new Post(row.id, row.title, row.authorId);
  }

  @method
  async feed(): Promise<
    Array<{ post: Reference<Post>; author: Reference<User> }>
  > {
    const rows = await db.posts.feed();
    return Promise.all(
      rows.map(async (r) => ({
        post: await ref(Post, r.id),
        author: await ref(User, r.authorId),
      })),
    );
  }
}

class UsersService extends Node {
  @edge(User, z.string())
  get(id: string): User {
    const row = db.users.find(id);
    return new User(row.id, row.name);
  }
}

class Api extends Node {
  @edge(PostsService) get posts(): PostsService {
    return new PostsService();
  }
  @edge(UsersService) get users(): UsersService {
    return new UsersService();
  }
}
```

## How It Works

When you call `ref(Class, ...args)`:

1. GraphPC calls `Class[canonicalPath](recordingProxy, ...args)` — the recording proxy captures each navigation step as a path segment, without executing real edge getters
2. The `[canonicalPath]` method navigates the proxy (e.g., `root.posts.get(id)`), capturing the path
3. GraphPC walks the **real** graph along that path, resolving each edge to get the actual node
4. The node's data fields are extracted (own properties and getter results)
5. Both the path and data are bundled into a `Reference<Class>`

References can be created from anywhere in your server-side code — inside methods, edge getters, or any code they call — as long as it runs within a request context (the API root is accessed via `AsyncLocalStorage`).

For more implementation details, see [Protocol Internals](internals.md).

## See Also

For **passing node identity** between client and server — or returning lightweight handles without bundled data — see [Path References](paths.md).
