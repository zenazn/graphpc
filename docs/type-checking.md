# Type Checking

## The Problem

TypeScript decorators have no type-level effect — `@edge(PostsService)` tells the runtime about a relationship, but the type system doesn't see it. This creates two gaps:

1. **Edge vs method ambiguity.** A method returning `Promise<Post>` could be an async edge or a method. The type system can't tell.
2. **Undecorated methods in autocomplete.** Every public method appears in `RpcStub<T>` autocomplete, even ones the runtime will reject.

The runtime is fully safe regardless — calls to undecorated methods are rejected, and attempting to traverse an undecorated property as an edge throws. This is purely about developer experience: autocomplete accuracy and compile-time error detection.

## The Solution: `Node` Base Class

All node classes (classes used as `@edge` targets) must extend `Node`:

```typescript
import { Node, edge, method } from "graphpc";

class Post extends Node {
  id: string;
  title: string;

  @method(z.string())
  async updateTitle(title: string): Promise<void> {
    /* ... */
  }
}

class PostsService extends Node {
  @edge(Post, z.string())
  get(id: string): Post {
    return new Post(id);
  }
}
```

`Node` is an abstract class with a single `declare readonly` property — zero runtime cost beyond the prototype chain entry. It gives the type system a structural brand to detect edges:

- **Function returning `T extends Node`** → sync edge → `RpcStub<T>`
- **Function returning `Promise<T>` where `T extends Node`** → async edge → `RpcStub<T>`
- **Function returning `T` or `Promise<T>` where `T` is not `Node`** → method → `Promise<T>`
- **Non-function property where type extends `Node`** → property edge → `RpcStub<T>`
- **Non-function, non-Node property** → data (accessible after `await`)

The `@edge` decorator also enforces this at runtime — calling `@edge(Target)` where `Target` doesn't extend `Node` throws immediately at class definition time.

## Shallow Return-Type Check

If a method returns a bare `Node` inside a container — like `Promise<Post[]>` — the type system produces an error type instead of allowing it silently. Bare nodes in containers can't be serialized over the wire (they're pass-by-reference objects).

The check covers: arrays, Maps, Sets, and one-level-deep object properties.

```typescript
class BadService extends Node {
  // Type error: returns ShallowNodeError
  @method
  async listPosts(): Promise<Post[]> {
    /* ... */
  }
}
```

The fix is to wrap with `Reference<T>`:

```typescript
class GoodService extends Node {
  @method
  async listPosts(): Promise<Reference<Post>[]> {
    return Promise.all(posts.map((p) => ref(Post, p.id)));
  }
}
```

See [References](references.md) for the full `ref()` API.

## ESLint Plugin

For the remaining gap — ensuring public methods are decorated — GraphPC includes an ESLint plugin.

### Setup (flat config)

```js
// eslint.config.js
import graphpc from "graphpc/eslint";

export default [
  graphpc.configs.recommended,
  // ... your other configs
];
```

### Rule: `graphpc/require-decorator`

Flags any public method on a `Node` subclass that isn't decorated with `@edge` or `@method`. These methods are rejected at runtime but appear in autocomplete, which is confusing.

Skipped: constructors, getters, setters, static methods, private/protected methods, `#private` methods.

**Known limitation:** The rule only detects direct `extends Node`, not transitive inheritance (e.g., `class Foo extends BaseService` where `BaseService extends Node`).
