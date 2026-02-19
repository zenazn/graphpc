# Path References

## The Problem

Sometimes a method needs to know _which node_ the caller is talking about. For example, moving a post to a different category — the method needs both the post and the category as arguments.

Since nodes live on the server, the client can't pass them directly. But it can pass the _path_ it used to reach them — the same segments the client navigated through edges. The server can then walk that path to get a live node.

## Naming Guide

There are five path-related exports. Here's a quick orientation before diving in:

- **`pathOf(stub)`** — client: extract path from any stub or data proxy → `PathArg`
- **`path(Class)`** — server: Standard Schema for `@method` params, validates + coerces → `Path<T>`
- **`Path<T>`** — server: thenable; `await` walks graph → live node
- **`PathArg`** — wire format: lightweight wrapper around path segments
- **`pathTo(Class, ...args)`** — server: create a `Path<T>` from `[canonicalPath]` (no graph walk)

## Accepting Paths as Method Arguments

The primary use case: a client tells the server "act on this node" by sending its path.

### Server side: `path(Class)` + `Path<T>`

Use `path(Class)` as a Standard Schema in `@method` to accept path arguments. It works exactly like `z.string()` or any other schema — no special-casing in the decorator system.

```typescript
import { Node, method, path, Path } from "graphpc";

class PostsService extends Node {
  @method(path(Post), path(Category))
  async move(post: Path<Post>, cat: Path<Category>): Promise<void> {
    const p = await post; // walks graph → live Post
    const c = await cat; // walks graph → live Category
    p.categoryName = c.name;
  }
}
```

`Path<T>` is a thenable. When awaited, it walks the real graph (using the same edge resolution as normal requests), validates that the result is an instance of the expected class, and returns the live node. If you don't await it, no graph walk happens.

### Client side: `pathOf()`

Use `pathOf(stub)` to extract the navigation path from any stub, edge accessor, or data proxy:

```typescript
import { pathOf } from "graphpc/client";

const post = client.root.posts.get("1");
const cat = client.root.categories.get("5");
await client.root.posts.move(pathOf(post), pathOf(cat));
```

`pathOf()` returns a `PathArg` — a lightweight wrapper around the path segments. The path is whatever the client navigated — **not** necessarily the canonical path.

## Returning Paths from Methods

`pathTo(Class, ...args)` creates a `Path<T>` from a class's `[canonicalPath]` **without** walking the graph. This is the one path function that requires `[canonicalPath]` — see [References](references.md#canonicalpath--declaring-canonical-paths) for how to declare one.

```typescript
import { Node, method, pathTo, Path } from "graphpc";

class PostsService extends Node {
  @method
  async listIds(): Promise<Path<Post>[]> {
    const ids = await db.posts.listIds();
    return ids.map((id) => pathTo(Post, id));
  }
}
```

Much cheaper than `ref()` — it just records path segments without executing edge getters or extracting data. The client receives each `Path<T>` as an `RpcStub<T>` — the same type as if they had navigated to that node via edges. They can then await it for data or continue navigating.

The trade-off vs `ref()`: the client must make a separate request to fetch data, whereas `ref()` bundles data into the response.

## Path vs Reference

|                            | `ref()` / `Reference<T>`           | `pathOf()` + `path()`         | `pathTo()`              |
| -------------------------- | ---------------------------------- | ----------------------------- | ----------------------- |
| Direction                  | Server → Client                    | Client → Server               | Server → Client         |
| Data included              | Yes (walks graph, extracts data)   | No                            | No                      |
| Path                       | Always canonical                   | Any path the client navigated | Always canonical        |
| Requires `[canonicalPath]` | Yes                                | No                            | Yes                     |
| Cost                       | Higher (graph walk + extraction)   | Validation only               | Path recording only     |
| Use case                   | Read-after-write, data pre-loading | "Act on this node"            | Cheap navigable handles |

## Validation and Security

`path()` performs a plausibility check before any graph walking:

1. **Schema validation**: walks the connection's schema to verify the path structurally leads to the expected type. The schema excludes `@hidden` edges, so paths through hidden edges are rejected.
2. **Type check**: verifies the path ends at the expected class index.
3. **Depth limit**: paths exceeding 64 segments are rejected.

These checks catch bogus paths early without executing edge getters. When the `Path<T>` is later awaited, it walks the real graph (which performs full authorization checks at each edge).

## Mixed Schemas

`path()` works alongside other Standard Schema validators in the same `@method`:

```typescript
@method(z.string(), path(Post))
async tag(label: string, post: Path<Post>): Promise<void> {
  const p = await post;
  // ...
}
```
