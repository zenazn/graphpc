# Testing

## Overview

GraphPC ships `mockConnect()` and `createMockTransportPair()` for testing without a real WebSocket. `mockConnect()` is the primary testing utility — it creates a mock transport pair, wires it to the server, and returns the client-side transport.

## `mockConnect()`

```typescript
import { mockConnect, createServer, createClient } from "graphpc";

const server = createServer({}, () => new Api());
const client = createClient<typeof server>({}, () => mockConnect(server, ctx));
```

`mockConnect(server, ctx)` creates a connected transport pair under the hood, calls `server.handle()` with the server-side transport and context, and returns the client-side transport. This mirrors production: the server wires up handlers and sends the hello message at connection time.

## `createMockTransportPair()`

For advanced tests that need to spy on raw wire messages or the server-side transport, use `createMockTransportPair()` directly:

```typescript
import { createMockTransportPair } from "graphpc";

const [serverTransport, clientTransport] = createMockTransportPair();
```

Returns two connected `Transport` objects. Messages sent on one are delivered to the other. No network, no ports, no async setup. Call `.close()` on either transport to simulate a disconnect.

## Testing a Server End-to-End

The most common pattern: create a server, connect it via `mockConnect`, and use a typed client to exercise the API.

```typescript
import { test, expect } from "bun:test"; // or Jest, ...
import { createServer, createClient, mockConnect } from "graphpc";

test("fetch a post by id", async () => {
  const server = createServer({}, () => new Api());
  const client = createClient<typeof server>({}, () => mockConnect(server, {}));

  const post = client.root.posts.get("1");
  const { title } = await post;

  expect(title).toBe("Hello World");
});
```

The client is fully typed — you get autocomplete for edges, methods, and data properties.

### Testing with Custom Types

If your server uses custom serialization types, pass the same config to both server and client:

```typescript
const customTypes = {
  reducers: {
    NotFound: (v: unknown) => v instanceof NotFound && [v.resource, v.id],
  },
  revivers: {
    NotFound: ([resource, id]: [string, string]) => new NotFound(resource, id),
  },
};

test("custom error survives round-trip", async () => {
  const server = createServer(customTypes, () => new Api());
  const client = createClient<typeof server>(customTypes, () =>
    mockConnect(server, {}),
  );

  try {
    await client.root.posts.get("missing");
    expect.unreachable("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(NotFound);
    expect((err as NotFound).resource).toBe("Post");
  }
});
```

### Testing Error Cases

```typescript
import { ValidationError, MethodNotFoundError, mockConnect } from "graphpc";

test("validation error on bad input", async () => {
  const server = createServer({}, () => new Api());
  const client = createClient<typeof server>({}, () => mockConnect(server, {}));

  try {
    await client.root.users.get("not-a-uuid");
    expect.unreachable("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).issues.length).toBeGreaterThan(0);
  }
});

test("nonexistent property throws MethodNotFoundError", async () => {
  const server = createServer({}, () => new Api());
  const client = createClient<typeof server>({}, () => mockConnect(server, {}));

  try {
    // @ts-expect-error — testing runtime behavior for nonexistent property
    await client.root.nonexistent;
    expect.unreachable("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(MethodNotFoundError);
  }
});
```

### Testing `@hidden` Edges

Pass different contexts to `mockConnect` to test visibility:

```typescript
test("admin edge is hidden from non-admin", async () => {
  const server = createServer({}, (ctx) => new Api());
  const client = createClient<typeof server>({}, () =>
    mockConnect(server, { userId: "1", isAdmin: false }),
  );

  try {
    await client.root.admin;
    expect.unreachable("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(MethodNotFoundError);
  }
});

test("admin edge is visible to admin", async () => {
  const server = createServer({}, (ctx) => new Api());
  const client = createClient<typeof server>({}, () =>
    mockConnect(server, { userId: "1", isAdmin: true }),
  );

  const panel = await client.root.admin;
  expect(panel).toBeDefined();
});
```

## Testing Individual Node Classes

You can unit test node classes directly — they're plain TypeScript classes:

```typescript
test("Post constructor sets fields", () => {
  const post = new Post("1", "Hello");
  expect(post.id).toBe("1");
  expect(post.title).toBe("Hello");
});

test("PostsService.get returns a post", () => {
  const service = new PostsService();
  const post = service.get("1");
  expect(post).toBeInstanceOf(Post);
  expect(post.title).toBe("Hello World");
});
```

**Note:** Methods that call `getContext()` or `ref()` require a server request context. They'll throw if called outside a `server.handle` session. For those, use the end-to-end pattern above.

## Deterministic Timers

`createServer` accepts a `timers` option for dependency injection, allowing deterministic timer control in tests:

```typescript
import type { Timers } from "graphpc";

const server = createServer(
  { idleTimeout: 5_000, timers: fakeTimers },
  factory,
);
```

The `Timers` interface requires `setTimeout` and `clearTimeout` with the standard signatures. GraphPC's internal test suite uses a `fakeTimers()` helper (in `src/test-utils.ts`) — you can write a similar helper for your tests.
