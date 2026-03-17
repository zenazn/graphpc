# Decorators

When to read this page: after [Getting Started](getting-started.md), when you need exact `@edge`, `@method`, `@stream`, and `@hidden` behavior.

GraphPC provides four decorators: `@edge`, `@method`, `@stream`, and `@hidden`.

## `@edge`

Marks a getter or method as an **edge** — it defines a relationship to another node in the graph.

The first argument is always the **target class** — the type of node the edge returns. The target must extend `Node`. This is how GraphPC builds the schema at connection time without instantiating anything.

### On getters

```typescript
class Api extends Node {
  @edge(PostsService)
  get posts(): PostsService {
    return new PostsService();
  }
}
```

### On methods

Pass [Standard Schema](https://standardschema.dev/) validators after the target class. Any compliant library works: zod, valibot, arktype, etc.

```typescript
class PostsService extends Node {
  @edge(Post, z.string())
  get(id: string): Post {
    return new Post(id);
  }
}
```

### Multiple parameters

```typescript
class SearchService extends Node {
  @edge(SearchResults, z.string(), z.number().optional())
  search(query: string, limit?: number): SearchResults {
    return new SearchResults(query, limit);
  }
}
```

Each positional schema validates the corresponding argument. Passing more arguments than there are schemas is an error.

### Self-referential edges

For edges that reference their own class (e.g. tree nodes), pass a thunk instead of the class directly:

```typescript
class TreeNode extends Node {
  @edge(() => TreeNode)
  get parent(): TreeNode {
    return this.#parent;
  }
}
```

This is necessary because the class binding isn't available during decorator evaluation. The thunk is resolved lazily at runtime.

## `@method`

Marks a method as callable by the client — it returns data over the wire. Methods can return `T` or `Promise<T>` — the client always receives `Promise<T>`.

```typescript
class PostsService extends Node {
  @method
  async list(): Promise<{ id: string; title: string }[]> {
    return db.posts.findMany();
  }

  @method
  total(): number {
    return this.#posts.size; // sync return — client gets Promise<number>
  }
}
```

Just like edges, positional schemas validate each parameter.

```typescript
class User extends Node {
  @method(z.string().email())
  async updateEmail(email: string): Promise<void> {
    await db.users.updateEmail(this.id, email);
  }
}
```

### Edge vs Method vs Stream: The Rule

- If the return value is an **object that clients can navigate further** -> `@edge(TargetClass)`
- If the return value is **data to consume** -> `@method`
- If returning a **push-based data feed** -> `@stream`

### Undecorated Access

Undecorated properties and getters are **data fields** — they're returned together by `await node` and accessible individually via `await node.fieldName`. No decorator is needed.

```typescript
class User extends Node {
  first: string; // Data field — included in await user
  last: string; // Data field — included in await user

  get fullName(): string {
    // Data field — also included in await user
    return `${this.first} ${this.last}`;
  }

  doStuff(): string {
    // NOT callable by clients — only @method-decorated functions are exposed
    return "nope";
  }
}
```

Only functions annotated with `@method` or `@stream` can be called by the client. Note that undecorated methods still appear in `RpcStub<T>` autocomplete — use the [ESLint plugin](types.md#eslint-plugin) to catch these at lint time.

## `@stream`

Marks an async generator method as a **server-push stream**. The client receives an `RpcStream<T>` — an async iterable that yields values as the server produces them.

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
      const batch = await db.notifications.after(lastId);
      for (const n of batch) {
        yield n;
        lastId = n.id;
      }
      await delay(1000);
    }
  }
}
```

### Parameters

The first parameter is always an `AbortSignal` — provided automatically by the framework, not by the client. The signal fires when the client cancels the stream or the connection closes.

Schemas validate the **remaining** parameters (after the signal). In the example above, `z.string().optional()` validates the `cursor` parameter.

### Client usage

```typescript
const stream = client.root.notifications.updates();

for await (const notification of stream) {
  console.log(notification.message);
}
```

The returned `RpcStream<T>` is an async iterable. It ends when:

- The server generator returns
- The client breaks out of the `for await` loop (sends a cancel)
- The connection closes (without a resume callback)

### Streams survive invalidation

Streams survive invalidation. A running stream is a source of data, not cached data. When a node is invalidated, any active stream on that node continues running. Invalidation marks the node's data as stale and notifies observers, but the async generator keeps yielding.

### Backpressure

Streams use credit-based flow control. The client sends `stream_credit` messages to indicate how many items it is ready to receive. The server pauses yielding when credits are exhausted, providing natural backpressure.

### Reconnect behavior

- **Without a resume callback**: on disconnect, the pending `next()` returns `{ done: true }`. The `for await` loop exits cleanly.
- **With a resume callback**: on disconnect, the pending `next()` blocks. On reconnect, `resume()` is called to get a new underlying stream, and the loop continues transparently.

To opt in to auto-resume, assign a `resume` callback on the stream object. The cursor must reflect the most recent successfully consumed message:

```typescript
let cursor: string | undefined;
const stream = client.root.notifications.updates(cursor);
stream.resume = () => client.root.notifications.updates(cursor);

for await (const msg of stream) {
  cursor = msg.id; // update cursor as messages are consumed
}
```

## `@hidden`

Conditionally hides a member from a connection's view based on the connection's context. Works on edges, methods, streams, and data fields (properties and getters, including inherited ones). The predicate receives the context and returns `true` to hide, `false` to show.

```typescript
@hidden((ctx) => !ctx.isAdmin)
@edge(AdminPanel)
get admin(): AdminPanel {
  return new AdminPanel();
}
```

When hidden, the edge or method is absent from the schema sent to the client, and any attempt to access it returns the same error as a nonexistent edge/method (no information leakage).

### Type safety

Augment the `Register` interface to type your request context:

```typescript
// env.d.ts
declare module "graphpc" {
  interface Register {
    context: {
      userId: string;
      isAdmin: boolean;
    };
  }
}
```

The predicate can base its decision on the context:

```typescript
@hidden((ctx) => !ctx.isAdmin) // ctx is typed from Register
```

### Composition with `@edge` / `@method` / `@stream`

`@hidden` stacks with `@edge`, `@method`, and `@stream`. The order of decorators doesn't matter, but by convention `@hidden` goes above `@edge`/`@method`/`@stream`.

```typescript
@hidden((ctx) => !ctx.isAdmin)
@edge(AdminPanel)
get admin(): AdminPanel { ... }

@hidden((ctx) => !ctx.isAdmin)
@method
async secretData(): Promise<string> { ... }

@hidden((ctx) => !ctx.isAdmin)
@stream
async *adminUpdates(signal: AbortSignal): AsyncGenerator<AdminEvent> { ... }

@hidden((ctx) => !ctx.isAdmin)
secretToken = "sk-...";  // data field — hidden from non-admins
```

### Error behavior

When hidden, the edge or method is absent from the schema sent to the client, and any attempt to access it returns the same error as a nonexistent edge or method — no information leakage. For protocol-level details, see [Error Handling](errors.md#hidden-member-nuance).

For the full story — context as the authentication layer, session revocation, and how `@hidden` fits into the authorization model — see [Authentication and Authorization](auth.md).

### Providing context

`createServer` returns a server instance with a `handle` method. Every connection must provide a context:

```typescript
const server = createServer({}, (ctx) => new Api());
server.handle(serverTransport, {
  userId: session.userId,
  isAdmin: session.role === "admin",
});
```

A common way to populate the context is by examining request cookies or headers.

## Validation

Both `@edge`, `@method`, and `@stream` accept positional Standard Schema validators. Arguments are validated server-side before the method executes.

```typescript
@edge(User, z.string().uuid())
get(id: string): User { ... }

@method(z.string().email(), z.string().min(1))
async updateProfile(email: string, name: string): Promise<void> { ... }

@stream(z.string())
async *events(signal: AbortSignal, channel: string): AsyncGenerator<Event> { ... }
```

On validation failure, the client receives a `ValidationError` with structured issues:

```typescript
try {
  await client.root.users.get("not-a-uuid");
} catch (err) {
  // err instanceof ValidationError
  // err.issues -> [{ message: "id: Invalid uuid", ... }]
}
```

### Parameter names

Parameter names are extracted on a best-effort basis from `Function.prototype.toString()` at decoration time. They appear in validation error messages for debugging:

```
"email: Invalid email"
```

### Path References as Arguments

Use `path(Class)` to accept client-side [path](glossary.md#path) references as method parameters:

```typescript
import { path, Path } from "graphpc";

@method(path(Post), path(Category))
async move(post: Path<Post>, cat: Path<Category>): Promise<void> {
  const p = await post;  // walks graph -> live Post
  const c = await cat;
}
```

`path(Class)` returns a standard `StandardSchemaV1`, so it works exactly like any other schema. On the client, `Path<T>` parameters appear as `PathArg` (see [Glossary](glossary.md)) — use `pathOf(stub)` to create one. See [Path References](identity.md) for full details.

## Standard Schema

GraphPC accepts any schema implementing the [Standard Schema](https://standardschema.dev/) interface. This means you're not locked into any specific validation library:

```typescript
// zod
@method(z.string().email())

// valibot
import * as v from "valibot";
@method(v.pipe(v.string(), v.email()))

// arktype
import { type } from "arktype";
@method(type("string.email"))
```

The only requirement is that the schema object has a `"~standard"` property with a `validate` method.

## Read This Next

1. [Authentication and Authorization](auth.md): using `@hidden` and context to shape per-connection schemas
2. [Identity and References](identity.md): `ref()`, `path()`, `pathOf()`, and `pathTo()`
3. [Types and Type Checking](types.md): lint and type-system guardrails
