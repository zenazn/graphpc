# Identity and References

When to read this page: when methods need to exchange node identity between client and server, with or without bundled node data.

## Quick Chooser

| If you need to...                                             | Use                      | Why                                                                      |
| ------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------ |
| Return navigable results from a `@method` with data preloaded | `ref()` / `Reference<T>` | Bundles canonical path + data so the client can use the node immediately |
| Return lightweight navigable handles without data             | `pathTo()`               | Records canonical paths without graph walking or data extraction         |
| Accept "act on this node" arguments from the client           | `path()` + `pathOf()`    | Client sends path identity; server validates and resolves on `await`     |

## References: Returning Navigable Results

By default, `@method` returns plain data. If callers must keep traversing or calling methods on returned objects, return `Reference<T>` values via `ref()`.

### `ref()` — Creating References

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

`ref()` is async. It resolves a canonical path, walks the real graph, and returns data plus path.

Use `ref()` when:

- a mutation should return fresh read-after-write data
- a listing method should return immediately usable nodes
- callers should continue traversal from method results

### `[canonicalPath]` — Declaring Canonical Paths

Every class used with `ref()` (or `pathTo()`) must define a static `[canonicalPath]` method.

```typescript
import { Node, canonicalPath } from "graphpc";

class Post extends Node {
  id: string;

  constructor(id: string) {
    super();
    this.id = id;
  }

  static [canonicalPath](root: Api, id: string) {
    return root.posts.get(id);
  }
}
```

Multi-hop and conditional canonical paths are valid as long as they return a recorded traversal result.

### Where References Can Appear

`ref()` works anywhere in a method return shape: arrays, objects, and nested structures.

```typescript
async list(): Promise<Reference<Post>[]> { ... }
async thread(): Promise<{ post: Reference<Post>; author: Reference<User> }> { ... }
```

### References and Caching

When a `Reference<T>` arrives on the client, GraphPC updates the persistent cache at that canonical path:

- node data is overwritten with fresh data
- per-property caches for that node are invalidated
- cached descendants are invalidated so future traversals re-resolve

This is the primary read-after-write mechanism. Alternatively, use `invalidate(stub)` to explicitly mark data as stale.

### References and Authorization

`ref()` walks real edges in the current connection context. If any canonical-path edge is unauthorized, the ref fails. References do not bypass auth boundaries.

### Reference Error Cases

- Missing `[canonicalPath]` on the class used by `ref()`
- `[canonicalPath]` returning a non-recorded value

## Path References: Passing Node Identity

Path references are lighter than references. They carry identity (path segments), not data.

### Naming Guide

- `pathOf(stub)` (client): extract a `PathArg` from a stub/data proxy
- `path(Class)` (server): method schema validating/coercing to `Path<T>`
- `Path<T>` (server): thenable; `await` walks graph to a live node
- `PathArg` (wire): serialized path wrapper
- `pathTo(Class, ...args)` (server): build canonical `Path<T>` without graph walk

### Accepting Paths as Method Arguments

Use `path(Class)` in `@method` schemas and accept `Path<T>` parameters.

```typescript
import { Node, method, path, Path } from "graphpc";

class PostsService extends Node {
  @method(path(Post), path(Category))
  async move(post: Path<Post>, cat: Path<Category>): Promise<void> {
    const p = await post;
    const c = await cat;
    p.categoryName = c.name;
  }
}
```

Client side:

```typescript
import { pathOf } from "graphpc/client";

const post = client.root.posts.get("1");
const cat = client.root.categories.get("5");
await client.root.posts.move(pathOf(post), pathOf(cat));
```

### Returning Paths from Methods

`pathTo(Class, ...args)` returns canonical path handles without data fetch/extraction cost.

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

Client-side, `Path<T>` return values are typed as `RpcStub<T>`.

### Validation and Security

`path()` validates before graph walking:

1. path shape matches current connection schema
2. endpoint type matches expected class
3. depth limit (64 segments)

Because connection schema excludes `@hidden` members, hidden-edge paths are rejected early. `await` still performs full real-graph auth checks.

## `ref()` vs Path Tools

|                            | `ref()` / `Reference<T>` | `pathOf()` + `path()`         | `pathTo()`              |
| -------------------------- | ------------------------ | ----------------------------- | ----------------------- |
| Direction                  | Server -> Client         | Client -> Server              | Server -> Client        |
| Data included              | Yes                      | No                            | No                      |
| Path                       | Canonical                | Caller-traversed path         | Canonical               |
| Requires `[canonicalPath]` | Yes                      | No                            | Yes                     |
| Typical use                | Fresh method results     | "Act on this node" parameters | Cheap navigable handles |

## How `ref()` Works (Short Version)

1. Calls `Class[canonicalPath](recordingProxy, ...args)`
2. Captures path segments from proxy traversal
3. Walks the real graph along that path
4. Extracts node data and bundles it with canonical path

For protocol-level details, see [Protocol Internals](internals.md).
