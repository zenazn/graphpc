# Type Safety

## `RpcStub<T>`

`RpcStub<T>` is a mapped type that transforms server API classes into their client-side stub equivalents. The client gets full TypeScript types inferred from the server definition — no hand-written client types, no codegen.

```typescript
import {
  createClient,
  createServer,
  createMockTransportPair,
  type RpcStub,
} from "graphpc";

const [serverTransport, clientTransport] = createMockTransportPair();

const server = createServer({}, (ctx) => new Api());
server.handle(serverTransport, {});

const client = createClient<typeof server>({}, () => clientTransport);
// client.root is RpcStub<Api>
```

## Transformation Rules

### Edge methods/getters → Synchronous stubs

Methods and getters that return a `Node` subclass produce a synchronous stub on the client. No network call happens — the stub just extends the navigation path.

```typescript
// Server
class Api extends Node {
  @edge(PostsService)
  get posts(): PostsService { ... }
}

// Client type: client.root is RpcStub<Api>
client.root.posts    // → RpcStub<PostsService>  (synchronous, no network)
```

### Edge methods with parameters → Callable stubs

```typescript
// Server
class PostsService extends Node {
  @edge(Post, z.string())
  get(id: string): Post { ... }
}

// Client type
client.root.posts.get("42")   // → RpcStub<Post>  (synchronous, no network)
```

### Async edges → Synchronous stubs

Methods returning `Promise<T>` where `T extends Node` are async edges — the client still gets a synchronous stub:

```typescript
// Server
class PostsService extends Node {
  @edge(Post, z.string())
  async load(id: string): Promise<Post> { ... }
}

// Client type — NOT Promise<RpcStub<Post>>, just RpcStub<Post>
client.root.posts.load("42")   // → RpcStub<Post>  (synchronous, no network)
```

### `@method` calls → Promises

Methods returning `T` or `Promise<T>` where `T` is not a `Node` produce `Promise<T>` on the client (all method calls are asynchronous over the wire):

```typescript
// Server
class PostsService extends Node {
  @method
  async count(): Promise<number> { ... }

  @method
  total(): number { ... }   // sync return also works
}

// Client type — both become Promise
client.root.posts.count()   // → Promise<number>  (network call)
client.root.posts.total()   // → Promise<number>  (network call)
```

### `await` on a stub → Data + stubs

Awaiting a node stub fetches all data fields (own properties and getter results). The resolved object includes both the fetched data and stubs for further navigation:

```typescript
// Server
class User extends Node {
  name: string;
  email: string;

  get fullName(): string {
    return `${this.name} (${this.email})`;
  }

  @edge(UserPosts)
  get posts(): UserPosts { ... }

  @method
  async updateName(name: string): Promise<void> { ... }
}

// Client
const user = client.root.users.get("42");   // RpcStub<User>
const data = await user;                    // { name, email, fullName } + edge/method stubs
data.name;                                  // "Alice" (data field)
data.fullName;                              // "Alice (alice@example.com)" (getter result)
data.posts;                                 // RpcStub<UserPosts> (still navigable)
await data.updateName("carl")               // Methods work too
```

## Path Parameter Mapping

When a `@method` accepts `Path<T>` parameters, the client type maps them to `PathArg`:

```typescript
// Server
class PostsService extends Node {
  @method(path(Post), path(Category))
  async move(post: Path<Post>, cat: Path<Category>): Promise<void> { ... }
}

// Client — Path<T> becomes PathArg
await client.root.posts.move(pathOf(postStub), pathOf(catStub));
```

When a `@method` returns `Path<T>` values, the client type unwraps them to `RpcStub<T>`:

```typescript
// Server
class PostsService extends Node {
  @method
  async listIds(): Promise<Path<Post>[]> { ... }
}

// Client — Path<Post>[] becomes RpcStub<Post>[]
const posts = await client.root.posts.listIds();
const data = await posts[0]; // fetches data via normal RPC
```

## Reference Unwrapping

When a `@method` returns `Reference<T>` values, the client type unwraps them automatically into data+stub hybrids:

```typescript
// Server
class PostsService extends Node {
  @method
  async list(): Promise<Reference<Post>[]> {
    const rows = await db.posts.findMany();
    return Promise.all(rows.map((p) => ref(Post, p.id)));
  }
}

// Client — Reference<Post> becomes a data+stub hybrid
const posts = await client.root.posts.list();
posts[0].title; // string (data, already available)
posts[0].updateTitle("New"); // Promise (method call, goes over wire)
```

## Compile-Time Only

`RpcStub<T>` exists only at compile time — it produces no runtime code. The actual runtime behavior is implemented by JavaScript `Proxy` objects in the client.

## How `RpcStub<T>` Detects Edges

All node classes extend `Node` (from `"graphpc"`). The `Node` class carries a type-level brand (`nodeTag`) that the type system uses to distinguish edges from methods and data:

- **Function returning `T extends Node`** → sync edge → `(...args) => RpcStub<T>`
- **Function returning `Promise<T>` where `T extends Node`** → async edge → `(...args) => RpcStub<T>`
- **Function returning `T` or `Promise<T>` where `T` is not `Node`** → method → `(...args) => Promise<T>`
- **Non-function property where type extends `Node`** → property edge → `RpcStub<T>`
- **Non-function, non-Node property** → data (accessible after `await`)

This is why `extends Node` is required. Without it, the type system can't tell if `Promise<Post>` is an async edge or a method returning data. See [Type Checking](type-checking.md) for the full explanation.
