# GraphPC

GraphPC is a TypeScript RPC framework where your API is a typed object graph.

Define your API as classes, navigate it as objects on the client, and keep end-to-end types without code generation.

## Why GraphPC

- **Typed graph traversal**: model API relationships as `@edge`s between classes.
- **Simple execution model**: edge navigation is local; data reads and methods are remote.
- **No codegen**: client types flow from `createClient<typeof server>(...)`.
- **Capability-shaped authorization**: graph reachability can define authorization boundaries.
- **SSR + hydration support**: use the same graph client model across server and browser.

## Mental Model in 30 Seconds

- **`@edge`**: navigate to another node (local, synchronous path building)
- **`@method`**: run an operation and return data (RPC)
- **`await node`**: load a node's data fields (public properties + getters, including inherited ones)

Server shape:

```typescript
import { Node, edge, method } from "graphpc";
import { z } from "zod";

class Post extends Node {
  title = "Hello";

  @method(z.string())
  async updateTitle(next: string): Promise<void> {
    this.title = next;
  }
}

class PostsService extends Node {
  @edge(Post, z.string())
  get(id: string): Post {
    return new Post();
  }
}
```

Client behavior:

```typescript
const post = client.root.posts.get("42"); // local path navigation
const { title } = await post; // RPC data fetch
await post.updateTitle("New"); // RPC method call
```

## Start Here

1. [Getting Started](docs/getting-started.md)
2. [Mental Model](docs/mental-model.md)
3. [Decorators](docs/decorators.md)
4. [Authentication and Authorization](docs/auth.md)
5. [Common Patterns](docs/patterns.md)
6. [Documentation Index](docs/index.md)

## Install

```bash
# bun
bun add graphpc zod

# npm
npm install graphpc zod

# pnpm
pnpm add graphpc zod
```

GraphPC works with any [Standard Schema](https://standardschema.dev/) validator (zod, valibot, arktype, etc.).

## Human ideas, AI code

GraphPC was designed by a human (Hi, I'm Carl!). The docs, code, and tests were largely produced with AI assistants, including Claude and Codex, then reviewed and edited by humans.
