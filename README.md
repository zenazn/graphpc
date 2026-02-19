# GraphPC

A type-safe graph API for TypeScript. Define your schema as classes, navigate it with method calls — like GraphQL, but without the query language.

## Install

```bash
bun add graphpc    # or npm, pnpm, yarn, etc.
```

GraphPC uses [Standard Schema](https://standardschema.dev/) for validation, so it works with any compliant library (zod, valibot, arktype, etc.). Install your preferred validator separately.

## Define your API as classes

```typescript
import { Node, edge, method } from "graphpc";
import { z } from "zod";

class Post extends Node {
  id: string;
  title: string;
  body: string;

  constructor(id: string, title: string, body: string) {
    super();
    this.id = id;
    this.title = title;
    this.body = body;
  }

  get summary(): string {
    return this.body.slice(0, 100);
  }

  @method(z.string())
  async updateTitle(title: string): Promise<void> {
    this.title = title;
  }
}

class PostsService extends Node {
  @edge(Post, z.string())
  get(id: string): Post {
    /* ... */
  }

  @method
  async count(): Promise<number> {
    /* ... */
  }
}

class Api extends Node {
  @edge(PostsService)
  get posts(): PostsService {
    return new PostsService();
  }
}
```

## Start a server

```typescript
import { createServer } from "graphpc";

const server = createServer({}, (ctx) => new Api());

// Bind to a WebSocket transport (Bun example)
Bun.serve({
  fetch(req, srv) {
    if (srv.upgrade(req, { data: { userId: "..." } })) return;
    return new Response("Upgrade required", { status: 426 });
  },
  websocket: server.wsHandlers<{ userId: string }>((data) => data),
});
```

## Connect a client

```typescript
import { createClient } from "graphpc";

const client = createClient<typeof server>(
  {},
  () => new WebSocket("ws://localhost:3000"),
);
```

## Use the client

```typescript
// Navigate edges (synchronous — no network call)
const post = client.root.posts.get("1");

// Await to fetch all data fields (own properties + getters)
const { id, title, summary } = await post;

// Read a single field (served from cache if node already loaded)
const t = await post.title;

// Call methods
await post.updateTitle("New Title");
console.log(await client.root.posts.count());
```

## Why GraphPC?

- **Typed graph traversal** — Navigate your API like an object graph with full TypeScript inference. No query language, no build step.
- **Rich type serialization** — GraphPC uses [devalue](https://github.com/sveltejs/devalue), which supports `Map`, `Set`, `Date`, `BigInt`, and more out of the box. You can register your own custom types too.
- **Authorization as graph structure** — If you can reach a node, you can use it. Permissions are enforced by graph topology, not middleware.
- **SSR with automatic hydration** — References serialize into HTML and rehydrate on the client. No framework-specific adapters needed.
- **No codegen** — Types flow from server to client at compile time via TypeScript inference.

## How it compares

|                   | GraphQL            | tRPC               | GraphPC            |
| ----------------- | ------------------ | ------------------ | ------------------ |
| Schema definition | SDL files          | TypeScript routers | TypeScript classes |
| Client queries    | GraphQL strings    | N/A (procedures)   | N/A (method calls) |
| Graph traversal   | Nested queries     | No (flat)          | Edge navigation    |
| Type safety       | Codegen            | Built-in           | Built-in           |
| SSR hydration     | Framework-specific | Framework-specific | Built-in           |

## Key Concepts

- **Node classes** extend `Node` — the base class for all graph nodes
- **Edges** (`@edge`) define relationships in the graph — the client gets a typed stub
- **Methods** (`@method`) resolve data — like a GraphQL resolver or mutation, but as a TypeScript method call
- **References** (`ref()`) point to other nodes in the graph, as if the client had navigated there itself. Use these to implement [pagination](https://github.com/zenazn/graphpc/blob/main/docs/patterns.md#pagination) and other patterns. See [References](https://github.com/zenazn/graphpc/blob/main/docs/references.md)

## Documentation

- [Architecture](https://github.com/zenazn/graphpc/blob/main/docs/architecture.md) — the API graph, edges vs methods, data flow
- [Decorators](https://github.com/zenazn/graphpc/blob/main/docs/decorators.md) — `@edge`, `@method`, `@hidden` usage
- [Authentication and Authorization](https://github.com/zenazn/graphpc/blob/main/docs/auth.md) — capability model, scoped subgraphs, session lifecycle
- [References](https://github.com/zenazn/graphpc/blob/main/docs/references.md) — `ref()`, `[canonicalPath]`, returning navigable objects from methods
- [Path References](https://github.com/zenazn/graphpc/blob/main/docs/paths.md) — `pathOf()`, `pathTo()`, passing node identity across the wire
- [Common Patterns](https://github.com/zenazn/graphpc/blob/main/docs/patterns.md) — resource hierarchies, pagination, component integration
- [Error Handling](https://github.com/zenazn/graphpc/blob/main/docs/errors.md) — thrown vs returned errors, custom error types, failure modes
- [Type Safety](https://github.com/zenazn/graphpc/blob/main/docs/type-safety.md) — `RpcStub<T>`, compile-time inference
- [Type Checking](https://github.com/zenazn/graphpc/blob/main/docs/type-checking.md) — `Node` base class, ESLint plugin, compile-time edge detection
- [SSR & Hydration](https://github.com/zenazn/graphpc/blob/main/docs/ssr-and-hydration.md) — server rendering, hydration lifecycle
- [Epochs & Caching](https://github.com/zenazn/graphpc/blob/main/docs/caching.md) — epoch lifecycle, request coalescing, cache lifetime, read-after-write
- [Reconnection](https://github.com/zenazn/graphpc/blob/main/docs/reconnection.md) — automatic reconnection, backoff, request replay
- [Testing](https://github.com/zenazn/graphpc/blob/main/docs/testing.md) — mock transports, testing servers and clients, SSR testing
- [Production](https://github.com/zenazn/graphpc/blob/main/docs/production.md) — error redaction, observability, abort signals, timeouts, connection limits

**Advanced:**

- [Protocol Internals](https://github.com/zenazn/graphpc/blob/main/docs/internals.md) — wire format, token machine, pipelining, concurrency & ordering, transport interface
- [Serialization](https://github.com/zenazn/graphpc/blob/main/docs/serialization.md) — devalue, custom types

**For AI assistants** or humans who like dense documentation, try our [LLM-oriented docs](https://github.com/zenazn/graphpc/blob/main/docs/llm.md)

## Human ideas, AI code

The ideas and design work for this library came from a human (Hi! I'm Carl!). The docs, code, and tests were substantially all written by Claude, an AI assistant. Claude was a very helpful collaborator, but humans have reviewed all of Claude's work. The documentation, which forms the spec for the library, has been particularly thoroughly reviewed and edited by humans.

This library welcomes feedback and contributions in that same vein: humans must provide the ideas, design work, and review, and are accountable for all communications and contributions. Humans are encouraged to use AI assistants for everything else, if they'd like.
