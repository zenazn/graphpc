# Getting Started

When to read this page: first, before any other GraphPC docs.

> You are here: Getting Started -> Mental Model -> Decorators -> Auth -> Patterns.

This page is the onboarding ramp for GraphPC:

1. What GraphPC is and why the model is different
2. The core mental model you need before coding
3. A basic end-to-end walkthrough (server + client)
4. What to learn next

If you are new to GraphPC, start here.

Need quick definitions while reading? See the [Glossary](glossary.md).

## What Is GraphPC?

GraphPC is a TypeScript RPC framework where your API is a **typed object graph**.

Instead of designing a flat list of procedures, you model your API as connected classes:

- Nodes represent domain objects/services
- Edges represent navigation between nodes
- Methods represent actions or data-returning operations

On the client, you navigate those edges synchronously through normal object access. Network requests happen only when you request data (`await node`, `await node.field`) or call a method.

### Why this is useful

- You keep your API structure close to your domain model.
- You get end-to-end types without code generation.
- You can express authorization as reachability in the graph.
- You can use the same client model in SSR and browser hydration.

## The 30-Second Mental Model

- **`@edge`**: "Go to another node" (local traversal, no immediate network call)
- **`@method`**: "Do work and return data" (always RPC)
- **Data fields**: public properties + getters on a node (including inherited ones, loaded by `await node`)

```typescript
const post = client.root.posts.get("42"); // local path building
const { title } = await post; // RPC
await post.updateTitle("New"); // RPC
```

## Walkthrough

This walkthrough builds a minimal API and client interaction in one pass.

### 1. Install

```bash
# bun
bun add graphpc zod

# npm
npm install graphpc zod

# pnpm
pnpm add graphpc zod
```

GraphPC accepts any [Standard Schema](https://standardschema.dev/) validator. This walkthrough uses zod.

### 2. Define your API

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
    return this.body.slice(0, 80);
  }

  @method(z.string())
  async updateTitle(nextTitle: string): Promise<void> {
    this.title = nextTitle;
  }
}

class PostsService extends Node {
  @edge(Post, z.string())
  get(id: string): Post {
    // replace with your DB read
    return new Post(id, `Post ${id}`, "Hello from GraphPC");
  }

  @method
  async count(): Promise<number> {
    // replace with your DB count
    return 1;
  }
}

class Api extends Node {
  @edge(PostsService)
  get posts(): PostsService {
    return new PostsService();
  }
}
```

At this point you have:

- one root node (`Api`)
- one navigable service edge (`root.posts`)
- one entity edge (`posts.get(id)`)
- one mutation method (`post.updateTitle(...)`)

### 3. Start a server

```typescript
import { createServer } from "graphpc";

const server = createServer({}, () => new Api());

Bun.serve({
  fetch(req, srv) {
    if (srv.upgrade(req, { data: {} })) return;
    return new Response("Upgrade required", { status: 426 });
  },
  websocket: server.wsHandlers((data) => data),
});
```

This creates the typed server and binds it to a WebSocket transport.

### 4. Connect a client

Use `graphpc/client` in browser and edge runtimes.

```typescript
import { createClient } from "graphpc/client";

const client = createClient<typeof server>(
  {},
  () => new WebSocket("ws://localhost:3000"),
);
```

`typeof server` gives the client full type inference from your server graph.

### 5. Traverse and call

```typescript
// Edge traversal is local and synchronous.
const post = client.root.posts.get("1");

// Await a node to fetch all data fields.
const { id, title, summary } = await post;

// Read one field directly.
const t = await post.title;

// Methods always execute over RPC.
await post.updateTitle("New Title");

const total = await client.root.posts.count();
```

At this point you have exercised all three surfaces:

- edges
- data fields
- methods

## Common First Decisions

### Edge or method?

- Return a navigable object → `@edge(TargetClass)`
- Return consumable data → `@method`

### Where should validation live?

Attach Standard Schema validators directly to `@edge` and `@method` params:

```typescript
@edge(Post, z.string().uuid())
get(id: string): Post { ... }

@method(z.string().min(1))
async rename(title: string): Promise<void> { ... }
```

## Read This Next

Recommended next order:

1. [Mental Model](mental-model.md): path identity, caching, and ordering intuition
2. [Decorators](decorators.md): full behavior of `@edge`, `@method`, `@hidden`
3. [Authentication and Authorization](auth.md): context + graph reachability model
4. [Common Patterns](patterns.md): pagination, resource hierarchies, component integration
5. [Testing](testing.md): `mockConnect` and transport-pair testing

When you need runtime behavior details, continue with:

- [Runtime Lifecycle](runtime-lifecycle.md)
- [Epochs and Caching](caching.md)
- [Reconnection](reconnection.md)
