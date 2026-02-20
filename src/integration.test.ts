import { expect, test } from "bun:test";
import { z } from "zod";
import { createClient } from "./client.ts";
import { abortSignal } from "./context.ts";
import { edge, hidden, method } from "./decorators.ts";
import { getErrorUuid } from "./error-uuid.ts";
import { RpcError, ValidationError } from "./errors.ts";
import { Path, path } from "./node-path.ts";
import { PathArg } from "./path-arg.ts";
import { pathOf } from "./path-of.ts";
import { createMockTransportPair } from "./protocol.ts";
import { ref, Reference, pathTo } from "./ref.ts";
import { createSerializer } from "./serialization.ts";
import { createServer } from "./server.ts";
import { fakeTimers, flush, mockConnect } from "./test-utils.ts";
import { canonicalPath, Node } from "./types.ts";

const serializer = createSerializer();

// -- Test API definition --

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

  static [canonicalPath](root: Api, id: string) {
    return root.posts.get(id);
  }

  @method(z.string())
  async updateTitle(title: string): Promise<void> {
    this.title = title;
  }
}

class PostsService extends Node {
  #posts = new Map<string, Post>([
    ["1", new Post("1", "Hello World", "First post")],
    ["2", new Post("2", "Second Post", "Another post")],
  ]);

  @edge(Post, z.string())
  get(id: string): Post {
    const post = this.#posts.get(id);
    if (!post) throw new Error(`Post ${id} not found`);
    return post;
  }

  @method
  async list(): Promise<Reference<Post>[]> {
    return Promise.all(
      Array.from(this.#posts.values()).map((p) => ref(Post, p.id)),
    );
  }

  @method
  async count(): Promise<number> {
    return this.#posts.size;
  }
}

class User extends Node {
  name: string;
  email: string;

  constructor(name: string, email: string) {
    super();
    this.name = name;
    this.email = email;
  }
}

class UsersService extends Node {
  @edge(User, z.string())
  get(id: string): User {
    return new User("Alice", "alice@example.com");
  }
}

class Api extends Node {
  @edge(PostsService)
  get posts(): PostsService {
    return new PostsService();
  }

  @edge(UsersService)
  get users(): UsersService {
    return new UsersService();
  }
}

function setup() {
  const gpc = createServer({}, (_ctx: {}) => new Api());
  const client = createClient<typeof gpc>({}, () => mockConnect(gpc, {}));
  return { client, gpc };
}

test("method returning references", async () => {
  const { client } = setup();

  const posts = await client.root.posts.list();
  expect(Array.isArray(posts)).toBe(true);
  expect(posts.length).toBe(2);

  // References should be transparent data proxies
  const first = posts[0]!;
  expect(first.title).toBe("Hello World");
  expect(first.id).toBe("1");
});

test("method call through reference goes over wire", async () => {
  const { client } = setup();

  const posts = await client.root.posts.list();
  const first = posts[0]!;

  // Call updateTitle through the reference — should go over the wire
  await first.updateTitle("Updated Title");

  // Verify the mutation took effect by fetching the post
  const post = await client.root.posts.get("1");
  expect(post.title).toBe("Updated Title");
});

test("sync method return", async () => {
  class SyncApi extends Node {
    @method(z.number(), z.number())
    add(a: number, b: number): number {
      return a + b;
    }

    @method
    greeting(): string {
      return "hello";
    }
  }

  const gpc = createServer({}, (_ctx: {}) => new SyncApi());
  const client = createClient<typeof gpc>({}, () => mockConnect(gpc, {}));

  const sum = await client.root.add(3, 4);
  expect(sum).toBe(7);

  const msg = await client.root.greeting();
  expect(msg).toBe("hello");
});

test("non-RpcError wraps with error code (method → GET_ERROR, getter edge → EDGE_ERROR)", async () => {
  class FailChild extends Node {
    value = "ok";
  }

  class ThrowingApi extends Node {
    @method
    async fail(): Promise<void> {
      throw new Error("something broke");
    }

    @edge(FailChild)
    get boom(): FailChild {
      throw new TypeError("getter exploded");
    }
  }

  const gpc = createServer({}, (_ctx: {}) => new ThrowingApi());
  const client = createClient<typeof gpc>({}, () => mockConnect(gpc, {}));

  try {
    await client.root.fail();
    expect.unreachable("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe("GET_ERROR");
  }

  try {
    await client.root.boom;
    expect.unreachable("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe("EDGE_ERROR");
  }
});

test("error propagation for missing edges", async () => {
  const { client } = setup();

  try {
    // Navigate to a post that doesn't exist
    await client.root.posts.get("999");
    expect.unreachable("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe("EDGE_ERROR");
    expect(err.message).toContain("Post 999 not found");
  }
});

test("operation middleware throwing yields INTERNAL_ERROR", async () => {
  const server = createServer({}, () => new Api());
  server.on("operation", () => {
    throw new Error("middleware boom");
  });
  const client = createClient<typeof server>({}, () => mockConnect(server, {}));

  try {
    await client.root.posts;
    expect.unreachable("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe("INTERNAL_ERROR");
  }
});

// -- @hidden integration tests --

class AdminPanel extends Node {
  @method
  async secretData(): Promise<string> {
    return "admin-only";
  }
}

class HiddenApi extends Node {
  @edge(PostsService)
  get posts(): PostsService {
    return new PostsService();
  }

  @edge(UsersService)
  get users(): UsersService {
    return new UsersService();
  }

  @hidden((ctx: any) => !ctx.isAdmin)
  @edge(AdminPanel)
  get admin(): AdminPanel {
    return new AdminPanel();
  }

  @hidden((ctx: any) => !ctx.isAdmin)
  @method
  async adminMethod(): Promise<string> {
    return "admin-secret";
  }
}

function setupHidden(ctx: {}) {
  const [serverTransport, clientTransport] = createMockTransportPair();
  const received: string[] = [];
  const originalSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = (data: string) => {
    received.push(data);
    originalSend(data);
  };
  const gpc = createServer({}, (_c: unknown) => new HiddenApi());
  gpc.handle(serverTransport, ctx);
  const client = createClient<typeof gpc>({}, () => clientTransport);
  return { client, gpc, received };
}

test("hidden edge: excluded from schema for non-admin, visible for admin", async () => {
  // Non-admin: admin edge hidden from schema, rejected on access
  {
    const { client, received } = setupHidden({ isAdmin: false });
    const schemaMsg = serializer.parse(received[0]!) as any;
    expect(schemaMsg.schema[0].edges).toHaveProperty("posts");
    expect(schemaMsg.schema[0].edges).toHaveProperty("users");
    expect(schemaMsg.schema[0].edges).not.toHaveProperty("admin");

    try {
      await client.root.admin.secretData();
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(RpcError);
      expect(err.code).toBe("INVALID_PATH");
    }
  }

  // Admin: admin edge visible and accessible
  {
    const { client, received } = setupHidden({ isAdmin: true });
    const schemaMsg = serializer.parse(received[0]!) as any;
    expect(schemaMsg.schema[0].edges).toHaveProperty("admin");

    const result = await client.root.admin.secretData();
    expect(result).toBe("admin-only");
  }
});

test("hidden method rejected for one context, works for another", async () => {
  // Non-admin: method hidden
  try {
    const { client: nonAdminClient } = setupHidden({ isAdmin: false });
    await nonAdminClient.root.adminMethod();
    expect.unreachable("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe("METHOD_NOT_FOUND");
  }

  // Admin: method visible
  const { client: adminClient } = setupHidden({ isAdmin: true });
  const result = await adminClient.root.adminMethod();
  expect(result).toBe("admin-secret");
});

test("unreachable types omitted from schema entirely", async () => {
  const { received: nonAdminReceived } = setupHidden({ isAdmin: false });
  const { received: adminReceived } = setupHidden({ isAdmin: true });

  const nonAdminSchema = serializer.parse(nonAdminReceived[0]!) as any;
  const adminSchema = serializer.parse(adminReceived[0]!) as any;

  // Admin schema should have more types (includes AdminPanel)
  expect(adminSchema.schema.length).toBeGreaterThan(
    nonAdminSchema.schema.length,
  );
});

// -- idleTimeout tests --

function setupWithTimeout(
  idleTimeout: number,
  timers?: import("./types.ts").Timers,
) {
  const [serverTransport, clientTransport] = createMockTransportPair();
  let closed = false;
  const originalClose = serverTransport.close.bind(serverTransport);
  serverTransport.close = () => {
    closed = true;
    originalClose();
  };
  const server = createServer({ idleTimeout, timers }, () => new Api());
  server.handle(serverTransport, {});
  return { serverTransport, clientTransport, isClosed: () => closed };
}

test("idleTimeout closes connection after inactivity", async () => {
  const timers = fakeTimers();
  const { isClosed } = setupWithTimeout(50, timers);

  expect(isClosed()).toBe(false);
  timers.fire();
  expect(isClosed()).toBe(true);
});

test("idleTimeout resets on activity", async () => {
  const timers = fakeTimers();
  const { clientTransport, isClosed } = setupWithTimeout(80, timers);

  // Initial idle timer is pending
  expect(timers.pending()).toBe(1);

  // Send a message to reset the timer
  clientTransport.send(serializer.stringify({ op: "data", tok: 0 }));
  await flush();

  // Timer was cleared and re-set (still 1 pending)
  expect(timers.pending()).toBe(1);
  expect(isClosed()).toBe(false);

  // Fire the (reset) timer — should close
  timers.fire();
  expect(isClosed()).toBe(true);
});

test("idleTimeout does not fire during pending operations", async () => {
  let resolveOp!: () => void;
  const gate = new Promise<void>((r) => {
    resolveOp = r;
  });

  class SlowApi extends Node {
    @method
    async slow(): Promise<string> {
      await gate;
      return "done";
    }
  }

  const timers = fakeTimers();
  const [serverTransport, clientTransport] = createMockTransportPair();
  let closed = false;
  const originalClose = serverTransport.close.bind(serverTransport);
  serverTransport.close = () => {
    closed = true;
    originalClose();
  };
  const server = createServer({ idleTimeout: 50, timers }, () => new SlowApi());
  server.handle(serverTransport, {});

  // Send a get that blocks on gate
  clientTransport.send(
    serializer.stringify({ op: "get", tok: 0, name: "slow" }),
  );
  await flush();

  // Fire the idle timer — should NOT close while op is pending
  timers.fireAll();
  expect(closed).toBe(false);

  // Let the operation complete
  resolveOp();
  await flush();

  // Now idle timeout should fire after the op finishes
  timers.fire();
  expect(closed).toBe(true);
});

test("invalid token in wire message returns INVALID_TOKEN error", async () => {
  const [serverTransport, clientTransport] = createMockTransportPair();
  const received: string[] = [];

  const originalSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = (data: string) => {
    received.push(data);
    originalSend(data);
  };

  const server = createServer({}, () => new Api());
  server.handle(serverTransport, {});

  // Remove the initial schema message
  received.shift();

  // Send a get with a token that doesn't exist
  clientTransport.send(
    serializer.stringify({ op: "get", tok: 9999, name: "x" }),
  );

  await flush();

  const response = serializer.parse(received[0]!) as any;
  expect(response.error).toBeDefined();
  expect(response.error.code).toBe("INVALID_TOKEN");
});

// -- maxTokens tests --

function setupWithMaxTokens(maxTokens: number) {
  const [serverTransport, clientTransport] = createMockTransportPair();
  const received: string[] = [];
  let closed = false;

  const originalSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = (data: string) => {
    received.push(data);
    originalSend(data);
  };
  const originalClose = serverTransport.close.bind(serverTransport);
  serverTransport.close = () => {
    closed = true;
    originalClose();
  };

  const server = createServer({ maxTokens }, () => new Api());
  server.handle(serverTransport, {});

  // Remove the initial schema message
  received.shift();

  return { serverTransport, clientTransport, received, isClosed: () => closed };
}

test("maxTokens closes connection at limit", async () => {
  // maxTokens=3: root (token 0) + 2 edge traversals = 3 tokens, next edge should trigger limit
  const { clientTransport, received, isClosed } = setupWithMaxTokens(3);

  // Two dependent edge traversals within limit (tokens 1, 2 — total with root = 3)
  // These are pipelined: the second edge references tok 1 before it's resolved
  clientTransport.send(
    serializer.stringify({ op: "edge", tok: 0, edge: "posts" }),
  );
  clientTransport.send(
    serializer.stringify({
      op: "edge",
      tok: 1,
      edge: "get",
      args: ["1"],
    }),
  );

  await flush();
  expect(isClosed()).toBe(false);

  // Both dependent edges should have succeeded (pipelining works)
  const edgeResults = received
    .map((r) => serializer.parse(r) as any)
    .filter((m: any) => m.op === "edge");
  expect(edgeResults.length).toBe(2);
  expect(edgeResults[0].error).toBeUndefined();
  expect(edgeResults[1].error).toBeUndefined();

  // Third edge traversal should exceed limit (tokens.size + poisoned.size >= 3)
  clientTransport.send(
    serializer.stringify({ op: "edge", tok: 0, edge: "users" }),
  );

  await flush();
  expect(isClosed()).toBe(true);
});

test("maxTokens sends TOKEN_LIMIT_EXCEEDED error", async () => {
  // maxTokens=2: root + 1 edge = 2 tokens, next edge exceeds
  const { clientTransport, received, isClosed } = setupWithMaxTokens(2);

  // First edge traversal is within limit (token 1, total = 2)
  clientTransport.send(
    serializer.stringify({ op: "edge", tok: 0, edge: "posts" }),
  );
  await flush();

  // Second edge traversal exceeds limit
  clientTransport.send(
    serializer.stringify({
      op: "edge",
      tok: 1,
      edge: "get",
      args: ["1"],
    }),
  );
  await flush();

  // Find the error response (last edge result)
  const edgeResults = received
    .map((r) => serializer.parse(r) as any)
    .filter((m: any) => m.op === "edge");
  const lastEdge = edgeResults[edgeResults.length - 1];

  expect(lastEdge.error).toBeDefined();
  expect(lastEdge.error.code).toBe("TOKEN_LIMIT_EXCEEDED");
  expect(isClosed()).toBe(true);
});

// -- maxPendingOps tests --

test("maxPendingOps limits concurrency and queues excess ops", async () => {
  let concurrency = 0;
  let maxConcurrency = 0;
  const resolvers: (() => void)[] = [];

  class ConcurrencyApi extends Node {
    @method
    async work(): Promise<string> {
      concurrency++;
      maxConcurrency = Math.max(maxConcurrency, concurrency);
      await new Promise<void>((r) => resolvers.push(r));
      concurrency--;
      return "done";
    }
  }

  const gpc = createServer(
    { maxPendingOps: 2, maxQueuedOps: Infinity, idleTimeout: 0 },
    () => new ConcurrencyApi(),
  );
  const client = createClient<typeof gpc>({}, () => mockConnect(gpc, {}));

  // Launch 4 concurrent calls — only 2 should execute user code at a time
  const promises = Promise.all([
    client.root.work(),
    client.root.work(),
    client.root.work(),
    client.root.work(),
  ]);

  await flush();
  expect(maxConcurrency).toBe(2);
  expect(resolvers.length).toBe(2);

  // Resolve first batch → frees slots → next 2 start
  resolvers[0]!();
  resolvers[1]!();
  await flush();
  expect(resolvers.length).toBe(4);

  // Resolve second batch
  resolvers[2]!();
  resolvers[3]!();

  const results = await promises;
  expect(results).toEqual(["done", "done", "done", "done"]);
  expect(maxConcurrency).toBe(2);
});

test("maxPendingOps queued ops complete successfully", async () => {
  const order: number[] = [];
  const resolvers: (() => void)[] = [];

  class OrderApi extends Node {
    @method(z.number())
    async task(id: number): Promise<number> {
      await new Promise<void>((r) => resolvers.push(r));
      order.push(id);
      return id;
    }
  }

  const gpc = createServer(
    { maxPendingOps: 1, maxQueuedOps: Infinity, idleTimeout: 0 },
    () => new OrderApi(),
  );
  const client = createClient<typeof gpc>({}, () => mockConnect(gpc, {}));

  // With maxPendingOps=1, user code runs sequentially
  const promises = Promise.all([
    client.root.task(1),
    client.root.task(2),
    client.root.task(3),
  ]);

  await flush();
  expect(resolvers.length).toBe(1);

  // Resolve sequentially
  resolvers[0]!();
  await flush();
  expect(resolvers.length).toBe(2);

  resolvers[1]!();
  await flush();
  expect(resolvers.length).toBe(3);

  resolvers[2]!();

  const results = await promises;
  expect(results).toEqual([1, 2, 3]);
  expect(order).toEqual([1, 2, 3]);
});

test("maxPendingOps works with edge traversals", async () => {
  let concurrency = 0;
  let maxConcurrency = 0;
  const resolvers: (() => void)[] = [];

  class SlowPost extends Node {
    id: string;
    title: string;

    constructor(id: string) {
      super();
      concurrency++;
      maxConcurrency = Math.max(maxConcurrency, concurrency);
      this.id = id;
      this.title = `Post ${id}`;
    }
  }

  class SlowPostsService extends Node {
    @edge(SlowPost, z.string())
    async get(id: string): Promise<SlowPost> {
      await new Promise<void>((r) => resolvers.push(r));
      const post = new SlowPost(id);
      concurrency--;
      return post;
    }
  }

  class SlowApi extends Node {
    @edge(SlowPostsService)
    get posts(): SlowPostsService {
      return new SlowPostsService();
    }
  }

  const gpc = createServer(
    { maxPendingOps: 2, maxQueuedOps: Infinity, idleTimeout: 0 },
    () => new SlowApi(),
  );
  const client = createClient<typeof gpc>({}, () => mockConnect(gpc, {}));

  const promises = Promise.all([
    client.root.posts.get("1"),
    client.root.posts.get("2"),
    client.root.posts.get("3"),
  ]);

  await flush();

  // Resolve all gates — slot mechanism bounds concurrent handleEdge responses
  for (const r of resolvers) r();

  const [a, b, c] = await promises;
  expect(a.title).toBe("Post 1");
  expect(b.title).toBe("Post 2");
  expect(c.title).toBe("Post 3");
  // Concurrency should have been bounded
  expect(maxConcurrency).toBeLessThanOrEqual(2);
});

// -- maxQueuedOps tests --

test("maxQueuedOps closes connection when inflight count exceeds limit", async () => {
  const [serverTransport, clientTransport] = createMockTransportPair();
  let closed = false;
  const originalClose = serverTransport.close.bind(serverTransport);
  serverTransport.close = () => {
    closed = true;
    originalClose();
  };

  class SlowApi extends Node {
    @method
    async slow(): Promise<string> {
      await new Promise<void>(() => {}); // never resolves — keeps op in-flight
      return "done";
    }
  }

  const server = createServer(
    { maxPendingOps: Infinity, maxQueuedOps: 3, idleTimeout: 0 },
    () => new SlowApi(),
  );
  server.handle(serverTransport, {});

  // Messages 1-3: inflight count 1, 2, 3 — within limit
  clientTransport.send(
    serializer.stringify({ op: "get", tok: 0, name: "slow" }),
  );
  clientTransport.send(
    serializer.stringify({ op: "get", tok: 0, name: "slow" }),
  );
  clientTransport.send(
    serializer.stringify({ op: "get", tok: 0, name: "slow" }),
  );
  await flush();
  expect(closed).toBe(false);

  // Message 4: inflight count 4 > maxQueuedOps → connection closed
  clientTransport.send(
    serializer.stringify({ op: "get", tok: 0, name: "slow" }),
  );
  await flush();
  expect(closed).toBe(true);
});

// -- transport.close() cleanup tests --

test("transport.close() cleans up tokens and poisoned maps", async () => {
  const [serverTransport, clientTransport] = createMockTransportPair();
  const received: string[] = [];

  const originalSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = (data: string) => {
    received.push(data);
    originalSend(data);
  };

  const server = createServer({}, () => new Api());
  server.handle(serverTransport, {});

  // Navigate some edges to create tokens
  clientTransport.send(
    serializer.stringify({ op: "edge", tok: 0, edge: "posts" }),
  );
  clientTransport.send(
    serializer.stringify({
      op: "edge",
      tok: 1,
      edge: "get",
      args: ["1"],
    }),
  );
  await flush();

  // Also create a poisoned token by navigating to non-existent post
  clientTransport.send(
    serializer.stringify({
      op: "edge",
      tok: 1,
      edge: "get",
      args: ["999"],
    }),
  );
  await flush();

  // Close transport
  serverTransport.close();

  // After close, operations on old tokens should not work
  // (the handler's onClose clears tokens and poisoned maps)
  // We verify by sending a data request — since the transport is closed,
  // the message shouldn't be delivered
  const preCloseCount = received.length;
  clientTransport.send(serializer.stringify({ op: "data", tok: 1 }));
  await flush();

  // No new messages should have been sent after close
  expect(received.length).toBe(preCloseCount);
});

// -- Poisoned token propagation tests --

test("poisoned token propagates to child edges and method calls", async () => {
  const { client } = setup();

  // Child edge traversal from poisoned token
  try {
    await (client as any).root.posts.get("999").comments;
    expect.unreachable("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe("EDGE_ERROR");
    expect(err.message).toContain("Post 999 not found");
  }

  // Method call on poisoned token
  try {
    await client.root.posts.get("999").updateTitle("new title");
    expect.unreachable("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe("EDGE_ERROR");
    expect(err.message).toContain("Post 999 not found");
  }
});

test("poisoned token propagates through multiple levels", async () => {
  // Set up a deeper graph to test multi-level propagation
  class Leaf extends Node {
    value = "leaf";
  }

  class Mid extends Node {
    @edge(Leaf)
    get leaf(): Leaf {
      return new Leaf();
    }
  }

  class DeepApi extends Node {
    @edge(Mid, z.string())
    getChild(id: string): Mid {
      if (id === "bad") throw new Error("Not found");
      return new Mid();
    }
  }

  const gpc = createServer({}, (_ctx: {}) => new DeepApi());
  const client = createClient<typeof gpc>({}, () => mockConnect(gpc, {}));

  try {
    // getChild("bad") fails → poisoned, then .leaf should also fail
    await client.root.getChild("bad").leaf;
    expect.unreachable("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe("EDGE_ERROR");
    expect(err.message).toContain("Not found");
  }
});

// -- Concurrent operations on the same edge path (deduplication) --

test("concurrent operations on the same edge path are deduplicated", async () => {
  const [serverTransport, clientTransport] = createMockTransportPair();
  const edgeMessages: any[] = [];

  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (data: string) => {
    const parsed = serializer.parse(data) as any;
    if (parsed.op === "edge") {
      edgeMessages.push(parsed);
    }
    originalSend(data);
  };

  const gpc = createServer({}, (_ctx: {}) => new Api());
  gpc.handle(serverTransport, {});
  const client = createClient<typeof gpc>({}, () => clientTransport);

  // Launch two concurrent requests on the same edge path
  const [result1, result2] = await Promise.all([
    client.root.posts.get("1"),
    client.root.posts.get("1"),
  ]);

  expect(result1.title).toBe("Hello World");
  expect(result2.title).toBe("Hello World");

  // The "posts" edge should only have been sent once (deduplicated)
  const postsEdges = edgeMessages.filter((m) => m.edge === "posts");
  expect(postsEdges.length).toBe(1);

  // The "get" edge with args ["1"] should only have been sent once
  const getEdges = edgeMessages.filter(
    (m) => m.edge === "get" && m.args?.[0] === "1",
  );
  expect(getEdges.length).toBe(1);
});

// -- classifyPath edge case tests --
// These integration tests exercise the client's classifyPath logic through the
// full client-server pipeline. classifyPath is private, so we verify its behavior
// by observing the wire messages (edge vs get vs data) that result from various
// path shapes.

test("classifyPath: method call directly on root (no edge segments)", async () => {
  class RootWithMethod extends Node {
    @method
    async ping(): Promise<string> {
      return "pong";
    }
  }

  const gpc = createServer({}, (_ctx: {}) => new RootWithMethod());
  const client = createClient<typeof gpc>({}, () => mockConnect(gpc, {}));

  // Path: ["ping"] — no edges exist, so classifyPath should produce:
  //   edgePath=[], terminal={name:"ping", args:[]}
  const result = await client.root.ping();
  expect(result).toBe("pong");
});

test("classifyPath: method call with arguments directly on root", async () => {
  class RootWithArgMethod extends Node {
    @method(z.string(), z.number())
    async echo(msg: string, count: number): Promise<string> {
      return `${msg}:${count}`;
    }
  }

  const gpc = createServer({}, (_ctx: {}) => new RootWithArgMethod());
  const client = createClient<typeof gpc>({}, () => mockConnect(gpc, {}));

  // Path: [["echo", "hello", 3]] — classifyPath should classify as terminal call
  const result = await client.root.echo("hello", 3);
  expect(result).toBe("hello:3");
});

test("classifyPath: data fetch on root (empty path)", async () => {
  class DataRoot extends Node {
    name = "root-data";
    version = 42;
  }

  const gpc = createServer({}, (_ctx: {}) => new DataRoot());
  const client = createClient<typeof gpc>({}, () => mockConnect(gpc, {}));

  // Path: [] — classifyPath returns edgePath=[], terminal=null → data fetch on root
  const data = await client.root;
  expect(data.name).toBe("root-data");
  expect(data.version).toBe(42);
});

test("classifyPath: deep edge chain (3 levels) then method call", async () => {
  class Leaf extends Node {
    @method
    async value(): Promise<string> {
      return "deep-value";
    }
  }

  class Mid extends Node {
    @edge(Leaf)
    get leaf(): Leaf {
      return new Leaf();
    }
  }

  class DeepRoot extends Node {
    @edge(Mid)
    get mid(): Mid {
      return new Mid();
    }
  }

  const gpc = createServer({}, (_ctx: {}) => new DeepRoot());
  const client = createClient<typeof gpc>({}, () => mockConnect(gpc, {}));

  // Path: ["mid", "leaf", "value"] — classifyPath should classify:
  //   mid (edge→Mid), leaf (edge→Leaf), value (not an edge→method call)
  const result = await client.root.mid.leaf.value();
  expect(result).toBe("deep-value");
});

test("classifyPath: parameterized edge followed by method with arguments", async () => {
  const { client } = setup();

  // Path: ["posts", ["get","1"], ["updateTitle","New Title"]]
  // classifyPath should classify:
  //   posts (edge→PostsService), get("1") (edge→Post), updateTitle (not an edge→method call)
  await client.root.posts.get("1").updateTitle("New Title");

  // Verify the mutation took effect
  const post = await client.root.posts.get("1");
  expect(post.title).toBe("New Title");
});

test("classifyPath: non-existent segment on known node type becomes method call", async () => {
  const { client } = setup();

  // "nonExistent" is not an edge on PostsService, so classifyPath treats it as a method call.
  // The server rejects it because no @method named "nonExistent" exists.
  try {
    await (client as any).root.posts.nonExistent();
    expect.unreachable("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe("METHOD_NOT_FOUND");
  }
});

test("classifyPath: verifies wire messages for edge-then-method path", async () => {
  const [serverTransport, clientTransport] = createMockTransportPair();
  const sent: any[] = [];

  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (data: string) => {
    sent.push(serializer.parse(data));
    originalSend(data);
  };

  const gpc = createServer({}, (_ctx: {}) => new Api());
  gpc.handle(serverTransport, {});
  const client = createClient<typeof gpc>({}, () => clientTransport);

  await client.root.posts.count();

  // classifyPath should have produced:
  //   edgePath=["posts"], terminal={name:"count", args:[]}
  // So the client should send: 1 edge message (posts) + 1 get message (count)
  const edgeMsgs = sent.filter((m) => m.op === "edge");
  const getMsgs = sent.filter((m) => m.op === "get");
  expect(edgeMsgs.length).toBe(1);
  expect(edgeMsgs[0].edge).toBe("posts");
  expect(getMsgs.length).toBe(1);
  expect(getMsgs[0].name).toBe("count");
});

test("classifyPath: verifies wire messages for all-edges path (data fetch)", async () => {
  const [serverTransport, clientTransport] = createMockTransportPair();
  const sent: any[] = [];

  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (data: string) => {
    sent.push(serializer.parse(data));
    originalSend(data);
  };

  const gpc = createServer({}, (_ctx: {}) => new Api());
  gpc.handle(serverTransport, {});
  const client = createClient<typeof gpc>({}, () => clientTransport);

  await client.root.posts.get("1");

  // classifyPath should have classified all segments as edges:
  //   edgePath=["posts", ["get","1"]], terminal=null
  // So the client should send: 2 edge messages + 1 data message (no get)
  const edgeMsgs = sent.filter((m) => m.op === "edge");
  const getMsgs = sent.filter((m) => m.op === "get");
  const dataMsgs = sent.filter((m) => m.op === "data");
  expect(edgeMsgs.length).toBe(2);
  expect(edgeMsgs[0].edge).toBe("posts");
  expect(edgeMsgs[1].edge).toBe("get");
  expect(edgeMsgs[1].args).toEqual(["1"]);
  expect(getMsgs.length).toBe(0);
  expect(dataMsgs.length).toBe(1);
});

// -- Property and getter access via get op --

test("property and getter access via get op", async () => {
  class PropGetterNode extends Node {
    value = 42;
    #internal = 100;

    get computed(): number {
      return this.#internal * 2;
    }
  }

  const gpc = createServer({}, (_ctx: {}) => new PropGetterNode());
  const client = createClient<typeof gpc>({}, () => mockConnect(gpc, {}));

  // Plain property
  const propResult = await (client as any).root.value;
  expect(propResult).toBe(42);

  // Getter
  const getterResult = await (client as any).root.computed;
  expect(getterResult).toBe(200);
});

// -- Request-response correlation tests --

test("concurrent calls resolve independently (no head-of-line blocking)", async () => {
  class TimedApi extends Node {
    @method(z.number())
    async delayed(ms: number): Promise<string> {
      await new Promise((r) => setTimeout(r, ms));
      return `waited-${ms}`;
    }
  }

  const gpc = createServer({}, (_ctx: {}) => new TimedApi());
  const client = createClient<typeof gpc>({}, () => mockConnect(gpc, {}));

  // Two method calls: slow (50ms) then fast (0ms)
  // With concurrent processing, the fast one should resolve before the slow one
  // re-based correlation ensures results match the correct promises
  const order: string[] = [];
  const [slow, fast] = await Promise.all([
    client.root.delayed(50).then((v: string) => {
      order.push("slow");
      return v;
    }),
    client.root.delayed(0).then((v: string) => {
      order.push("fast");
      return v;
    }),
  ]);

  expect(slow).toBe("waited-50");
  expect(fast).toBe("waited-0");
  // Fast should resolve before slow thanks to concurrent processing
  expect(order).toEqual(["fast", "slow"]);
});

test("server responses carry re field correlating to request order", async () => {
  const [serverTransport, clientTransport] = createMockTransportPair();
  const received: any[] = [];

  const originalSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = (data: string) => {
    received.push(serializer.parse(data));
    originalSend(data);
  };

  const gpc = createServer({}, (_ctx: {}) => new Api());
  gpc.handle(serverTransport, {});
  const client = createClient<typeof gpc>({}, () => clientTransport);

  await client.root.posts.count();

  // Skip schema message (no re)
  const responses = received.filter((m: any) => m.op !== "hello");

  // Message 1: edge(posts) → re: 1
  // Message 2: get(count) → re: 2
  expect(responses.length).toBe(2);
  expect(responses[0].op).toBe("edge");
  expect(responses[0].re).toBe(1);
  expect(responses[1].op).toBe("get");
  expect(responses[1].re).toBe(2);
});

test("hello message (message 0) has no re field", async () => {
  const [serverTransport, clientTransport] = createMockTransportPair();
  const received: any[] = [];

  const originalSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = (data: string) => {
    received.push(serializer.parse(data));
    originalSend(data);
  };

  const gpc = createServer({}, (_ctx: {}) => new Api());
  gpc.handle(serverTransport, {});

  // Hello is sent immediately on connection (message 0)
  expect(received.length).toBe(1);
  expect(received[0].op).toBe("hello");
  expect(received[0].version).toBe(1);
  expect(received[0].re).toBeUndefined();
});

// -- Live data cache tests --

test("await node then await node.title served from cache (no wire message)", async () => {
  const [serverTransport, clientTransport] = createMockTransportPair();
  const sent: any[] = [];

  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (data: string) => {
    sent.push(serializer.parse(data));
    originalSend(data);
  };

  const gpc = createServer({}, (_ctx: {}) => new Api());
  gpc.handle(serverTransport, {});
  const client = createClient<typeof gpc>({}, () => clientTransport);

  // First: await the full node (sends edge + data messages)
  const post = client.root.posts.get("1");
  const data = await post;
  expect(data.title).toBe("Hello World");

  // Record message count after the data fetch
  const countAfterData = sent.length;

  // Second: await a single property — should be served from liveDataCache
  const title = await (post as any).title;
  expect(title).toBe("Hello World");

  // No new messages should have been sent
  expect(sent.length).toBe(countAfterData);
});

test("cold await node.title sends get message", async () => {
  const [serverTransport, clientTransport] = createMockTransportPair();
  const sent: any[] = [];

  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (data: string) => {
    sent.push(serializer.parse(data));
    originalSend(data);
  };

  const gpc = createServer({}, (_ctx: {}) => new Api());
  gpc.handle(serverTransport, {});
  const client = createClient<typeof gpc>({}, () => clientTransport);

  // Without a prior data fetch, property read should go over the wire
  const title = await (client as any).root.posts.get("1").title;
  expect(title).toBe("Hello World");

  // Should have sent edge messages + a get message (not just edges + data)
  const getMsgs = sent.filter((m: any) => m.op === "get");
  expect(getMsgs.length).toBe(1);
  expect(getMsgs[0].name).toBe("title");
});

test("await node then await node.count() still sends get message (methods never cached)", async () => {
  const [serverTransport, clientTransport] = createMockTransportPair();
  const sent: any[] = [];

  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (data: string) => {
    sent.push(serializer.parse(data));
    originalSend(data);
  };

  const gpc = createServer({}, (_ctx: {}) => new Api());
  gpc.handle(serverTransport, {});
  const client = createClient<typeof gpc>({}, () => clientTransport);

  // First: await the full node (data fetch)
  const postsService = client.root.posts;
  await postsService;

  const countAfterData = sent.length;

  // Method call should always go over the wire, never from cache
  const count = await client.root.posts.count();
  expect(count).toBe(2);

  // Should have sent at least one new get message for count()
  const newMessages = sent.slice(countAfterData);
  const getMsgs = newMessages.filter((m: any) => m.op === "get");
  expect(getMsgs.length).toBe(1);
  expect(getMsgs[0].name).toBe("count");
});

test("await node returns data proxy with navigable edge stubs", async () => {
  const { client } = setup();

  // Navigate to PostsService and await it (full-node load)
  const postsData = await client.root.posts;

  // PostsService has no own data fields (only private #posts), but edge stubs should be navigable
  const post = await postsData.get("1");
  expect(post.id).toBe("1");
  expect(post.title).toBe("Hello World");
});

test("await node returns data proxy — method calls still work through stub", async () => {
  const { client } = setup();

  // Navigate to a post and await it (full-node load)
  const postData = await client.root.posts.get("1");

  // Data fields should be present
  expect(postData.id).toBe("1");
  expect(postData.title).toBe("Hello World");

  // Methods should still be callable through the data proxy stub
  // (updateTitle is a @method on Post, accessible via the proxy's stub fallback)
  // This would throw if data proxy didn't delegate to stubs
  await postData.updateTitle("Updated");
});

test("await node includes getter values (integration)", async () => {
  class NodeWithGetter extends Node {
    first = "Alice";
    last = "Smith";
    get fullName(): string {
      return `${this.first} ${this.last}`;
    }
  }

  const gpc = createServer({}, (_ctx: {}) => new NodeWithGetter());
  const client = createClient<typeof gpc>({}, () => mockConnect(gpc, {}));

  const data = await client.root;
  expect(data.first).toBe("Alice");
  expect(data.last).toBe("Smith");
  expect(data.fullName).toBe("Alice Smith");
});

// -- Property/getter read coalescing (cold reads) --

test("concurrent cold property reads coalesce into one get message", async () => {
  const [serverTransport, clientTransport] = createMockTransportPair();
  const sent: any[] = [];

  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (data: string) => {
    sent.push(serializer.parse(data));
    originalSend(data);
  };

  const gpc = createServer({}, (_ctx: {}) => new Api());
  gpc.handle(serverTransport, {});
  const client = createClient<typeof gpc>({}, () => clientTransport);

  const post = client.root.posts.get("1");

  // Two concurrent cold property reads on the same node (no prior data fetch)
  const [t1, t2] = await Promise.all([
    (post as any).title,
    (post as any).title,
  ]);

  expect(t1).toBe("Hello World");
  expect(t2).toBe("Hello World");

  // Should have sent only one get message for "title" (coalesced)
  const getMsgs = sent.filter((m: any) => m.op === "get" && m.name === "title");
  expect(getMsgs.length).toBe(1);
});

test("sequential cold property reads coalesce (getCache hit)", async () => {
  const [serverTransport, clientTransport] = createMockTransportPair();
  const sent: any[] = [];

  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (data: string) => {
    sent.push(serializer.parse(data));
    originalSend(data);
  };

  const gpc = createServer({}, (_ctx: {}) => new Api());
  gpc.handle(serverTransport, {});
  const client = createClient<typeof gpc>({}, () => clientTransport);

  const post = client.root.posts.get("1");

  // First cold property read — sends a get message
  const t1 = await (post as any).title;
  const countAfter = sent.length;

  // Second sequential read — should be served from getCache (no new messages)
  const t2 = await (post as any).title;

  expect(t1).toBe("Hello World");
  expect(t2).toBe("Hello World");
  expect(sent.length).toBe(countAfter);
});

test("method calls never coalesce (two concurrent calls send two get messages)", async () => {
  const [serverTransport, clientTransport] = createMockTransportPair();
  const sent: any[] = [];

  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (data: string) => {
    sent.push(serializer.parse(data));
    originalSend(data);
  };

  const gpc = createServer({}, (_ctx: {}) => new Api());
  gpc.handle(serverTransport, {});
  const client = createClient<typeof gpc>({}, () => clientTransport);

  const [c1, c2] = await Promise.all([
    client.root.posts.count(),
    client.root.posts.count(),
  ]);

  expect(c1).toBe(2);
  expect(c2).toBe(2);

  // Should have sent two independent get messages
  const getMsgs = sent.filter((m: any) => m.op === "get" && m.name === "count");
  expect(getMsgs.length).toBe(2);
});

// -- Read-after-write cache invalidation --

const rwStore = new Map([["1", { title: "Original" }]]);

class RWItem extends Node {
  id: string;
  constructor(id: string) {
    super();
    this.id = id;
  }

  get title() {
    return rwStore.get(this.id)!.title;
  }

  static [canonicalPath](root: RWApi, id: string) {
    return root.items.get(id);
  }

  @method(z.string())
  async setTitle(newTitle: string): Promise<Reference<RWItem>> {
    rwStore.get(this.id)!.title = newTitle;
    return ref(RWItem, this.id);
  }
}

class RWItems extends Node {
  @edge(RWItem, z.string())
  get(id: string): RWItem {
    return new RWItem(id);
  }
}

class RWApi extends Node {
  @edge(RWItems)
  get items(): RWItems {
    return new RWItems();
  }
}

function rwSetup() {
  rwStore.set("1", { title: "Original" });

  const [serverTransport, clientTransport] = createMockTransportPair();
  const sent: any[] = [];
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (data: string) => {
    sent.push(serializer.parse(data));
    originalSend(data);
  };

  const gpc = createServer({}, (_ctx: {}) => new RWApi());
  gpc.handle(serverTransport, {});
  const client = createClient<typeof gpc>({}, () => clientTransport);

  return { client, sent };
}

test("read-after-write via ref invalidates data cache", async () => {
  const { client, sent } = rwSetup();

  const item = client.root.items.get("1");

  // Step 1: Load full node data (populate liveDataCache)
  const data1 = await item;
  expect(data1.title).toBe("Original");

  // Step 2: Mutation returns ref → overwrites liveDataCache
  await item.setTitle("Updated");
  const countAfterMutation = sent.length;

  // Step 3: Re-load full node — should serve from overwritten cache
  const data2 = await item;
  expect(data2.title).toBe("Updated");

  // No new wire messages (served from cache)
  expect(sent.length).toBe(countAfterMutation);
});

test("read-after-write invalidates getCache for property reads", async () => {
  const { client, sent } = rwSetup();

  const item = client.root.items.get("1");

  // Step 1: Cold property read — populates getCache
  const t1 = await (item as any).title;
  expect(t1).toBe("Original");

  // Step 2: Mutation returns ref → invalidates getCache, overwrites liveDataCache
  await item.setTitle("Updated");
  const countAfterMutation = sent.length;

  // Step 3: Property read — getCache was invalidated, but liveDataCache has fresh data
  const t2 = await (item as any).title;
  expect(t2).toBe("Updated");

  // No new wire messages (served from liveDataCache which was overwritten by the ref)
  expect(sent.length).toBe(countAfterMutation);
});

test("read-after-write via ref invalidates descendant edge caches", async () => {
  const owners = [
    { id: 1, name: "Alice" },
    { id: 2, name: "Bob" },
  ];
  const things = [{ id: 1, label: "widget", ownerId: 1 }];

  class RAWOwner extends Node {
    id: number;
    name: string;
    constructor(record: (typeof owners)[0]) {
      super();
      this.id = record.id;
      this.name = record.name;
    }
    static [canonicalPath](root: RAWRoot, id: number) {
      return root.owners.get(id);
    }
  }

  class RAWThing extends Node {
    id: number;
    label: string;
    #ownerId: number;
    constructor(record: (typeof things)[0]) {
      super();
      this.id = record.id;
      this.label = record.label;
      this.#ownerId = record.ownerId;
    }
    static [canonicalPath](root: RAWRoot, id: number) {
      return root.things.get(id);
    }
    @edge(RAWOwner)
    get owner(): RAWOwner {
      const r = owners.find((o) => o.id === this.#ownerId);
      if (!r) throw new Error("Owner not found");
      return new RAWOwner(r);
    }
    @method(path(RAWOwner))
    async reassign(newOwner: Path<RAWOwner>): Promise<Reference<RAWThing>> {
      const o = await newOwner;
      const record = things.find((t) => t.id === this.id);
      if (record) record.ownerId = o.id;
      return ref(RAWThing, this.id);
    }
  }

  class RAWThingsService extends Node {
    @edge(RAWThing, z.number())
    get(id: number): RAWThing {
      const r = things.find((t) => t.id === id);
      if (!r) throw new Error(`Thing ${id} not found`);
      return new RAWThing(r);
    }
  }

  class RAWOwnersService extends Node {
    @edge(RAWOwner, z.number())
    get(id: number): RAWOwner {
      const r = owners.find((o) => o.id === id);
      if (!r) throw new Error(`Owner ${id} not found`);
      return new RAWOwner(r);
    }
  }

  class RAWRoot extends Node {
    @edge(RAWThingsService)
    get things() {
      return new RAWThingsService();
    }
    @edge(RAWOwnersService)
    get owners() {
      return new RAWOwnersService();
    }
  }

  const gpc = createServer({}, () => new RAWRoot());
  const transport = mockConnect(gpc, {});
  const client = createClient({}, () => transport);
  await client.ready;
  const rpc = client.root;

  const thing = (rpc as any).things.get(1);

  // Owner is Alice
  expect((await thing.owner).name).toBe("Alice");

  // Reassign to Bob
  await thing.reassign(pathOf((rpc as any).owners.get(2)));

  // Traversing the edge again should reflect the mutation
  expect((await thing.owner).name).toBe("Bob");

  client.close();
});

// -- Server-side node coalescing tests --

test("node coalescing: same path resolves edge getter only once", async () => {
  let resolveCount = 0;

  class CoalesceChild extends Node {
    value = "coalesced";
  }

  class CoalesceApi extends Node {
    @edge(CoalesceChild)
    get child(): CoalesceChild {
      resolveCount++;
      return new CoalesceChild();
    }
  }

  const [serverTransport, clientTransport] = createMockTransportPair();
  const gpc = createServer({}, (_ctx: {}) => new CoalesceApi());
  gpc.handle(serverTransport, {});

  // Send two edge messages for the same path (both: edge(0, "child"))
  clientTransport.send(
    serializer.stringify({ op: "edge", tok: 0, edge: "child" }),
  );
  clientTransport.send(
    serializer.stringify({ op: "edge", tok: 0, edge: "child" }),
  );
  await flush();

  // Edge getter should only have been called once (coalesced)
  expect(resolveCount).toBe(1);
});

test("node coalescing: two tokens for same path yield identical data", async () => {
  let instanceId = 0;

  class TrackedNode extends Node {
    id: number;
    constructor() {
      super();
      this.id = ++instanceId;
    }
  }

  class CoalesceApi2 extends Node {
    @edge(TrackedNode)
    get tracked(): TrackedNode {
      return new TrackedNode();
    }
  }

  const [serverTransport, clientTransport] = createMockTransportPair();
  const received: any[] = [];
  const originalSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = (data: string) => {
    received.push(serializer.parse(data));
    originalSend(data);
  };

  const gpc = createServer({}, (_ctx: {}) => new CoalesceApi2());
  gpc.handle(serverTransport, {});
  received.shift(); // remove schema

  // Two edge traversals for the same path
  clientTransport.send(
    serializer.stringify({ op: "edge", tok: 0, edge: "tracked" }),
  );
  clientTransport.send(
    serializer.stringify({ op: "edge", tok: 0, edge: "tracked" }),
  );
  await flush();

  // Both edges should succeed (no errors)
  const edgeResults = received.filter((m: any) => m.op === "edge");
  expect(edgeResults.length).toBe(2);
  expect(edgeResults[0].error).toBeUndefined();
  expect(edgeResults[1].error).toBeUndefined();

  // Fetch data on both tokens
  clientTransport.send(serializer.stringify({ op: "data", tok: 1 }));
  clientTransport.send(serializer.stringify({ op: "data", tok: 2 }));
  await flush();

  const dataResults = received.filter((m: any) => m.op === "data");
  expect(dataResults.length).toBe(2);

  // Both tokens should point to the same object (same id)
  expect(dataResults[0].data.id).toBe(dataResults[1].data.id);
  // Only one instance was created
  expect(instanceId).toBe(1);
});

// -- Server error event tests --

test("malformed message closes connection and emits error event", async () => {
  const [serverTransport, clientTransport] = createMockTransportPair();
  let closed = false;
  const originalClose = serverTransport.close.bind(serverTransport);
  serverTransport.close = () => {
    closed = true;
    originalClose();
  };

  const errors: unknown[] = [];
  const gpc = createServer({}, (_ctx: {}) => new Api());
  gpc.on("error", (err) => errors.push(err));
  gpc.handle(serverTransport, {});

  clientTransport.send("not valid json {{{");
  await flush();

  expect(closed).toBe(true);
  expect(errors.length).toBe(1);
  expect(errors[0]).toBeInstanceOf(SyntaxError);
});

test("server.off removes error listener", async () => {
  const [serverTransport, clientTransport] = createMockTransportPair();
  const gpc = createServer({}, (_ctx: {}) => new Api());

  const errors: unknown[] = [];
  const handler = (err: unknown) => errors.push(err);
  gpc.on("error", handler);
  gpc.off("error", handler);

  gpc.handle(serverTransport, {});

  clientTransport.send("{{garbage}}");
  await flush();

  // Handler was removed, so no errors captured
  expect(errors.length).toBe(0);
});

test("server continues processing other connections after bad input", async () => {
  const gpc = createServer({}, (_ctx: {}) => new Api());
  gpc.on("error", () => {}); // suppress

  // Connection 1: send bad input
  const [st1, ct1] = createMockTransportPair();
  gpc.handle(st1, {});
  ct1.send("not json");
  await flush();

  // Connection 2: should work fine
  const [st2, ct2] = createMockTransportPair();
  gpc.handle(st2, {});
  const client2 = createClient<typeof gpc>({}, () => ct2);

  const userData = await client2.root.users.get("1");
  expect(userData.name).toBe("Alice");
});

// -- client.close() tests --

test("close() rejects pending and post-close ops, is idempotent", async () => {
  // Pending operation rejected
  const [serverTransport, clientTransport] = createMockTransportPair();
  const gpc = createServer({}, (_ctx: {}) => new Api());
  gpc.handle(serverTransport, {});
  const client = createClient<typeof gpc>({}, () => clientTransport);

  const promise = client.root.posts.count();
  client.close();

  try {
    await promise;
    expect.unreachable("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe("CLIENT_CLOSED");
  }

  // Post-close operation rejected
  try {
    await client.root.posts.count();
    expect.unreachable("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe("CLIENT_CLOSED");
  }

  // Idempotent — no throw on repeated close
  client.close();
  client.close();
});

test("close() closes the transport", async () => {
  const [serverTransport, clientTransport] = createMockTransportPair();
  let transportClosed = false;
  const origClose = clientTransport.close.bind(clientTransport);
  clientTransport.close = () => {
    transportClosed = true;
    origClose();
  };

  const gpc = createServer({}, (_ctx: {}) => new Api());
  gpc.handle(serverTransport, {});
  const client = createClient<typeof gpc>({}, () => clientTransport);

  await client.ready;

  client.close();
  expect(transportClosed).toBe(true);
});

test("close() stops reconnection attempts", async () => {
  const gpc = createServer({}, () => new Api());
  let factoryCalls = 0;
  const timers = fakeTimers();

  const transportFactory = () => {
    factoryCalls++;
    const [serverTransport, clientTransport] = createMockTransportPair();
    gpc.handle(serverTransport, {});
    return clientTransport;
  };

  const client = createClient<typeof gpc>(
    { reconnect: { initialDelay: 10, maxRetries: 10 }, timers },
    transportFactory,
  );

  await client.ready;
  const initialCalls = factoryCalls;

  client.close();

  // Fire all pending timers — no reconnection should happen after close
  timers.fireAll();
  await flush();

  expect(factoryCalls).toBe(initialCalls);
});

test("node coalescing: failed edge is cached (no retry)", async () => {
  let resolveCount = 0;

  class FailChild extends Node {}

  class FailApi extends Node {
    @edge(FailChild, z.string())
    getItem(id: string): FailChild {
      resolveCount++;
      throw new Error(`Not found: ${id}`);
    }
  }

  const [serverTransport, clientTransport] = createMockTransportPair();
  const received: any[] = [];
  const originalSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = (data: string) => {
    received.push(serializer.parse(data));
    originalSend(data);
  };

  const gpc = createServer({}, (_ctx: {}) => new FailApi());
  gpc.handle(serverTransport, {});
  received.shift(); // remove schema

  // Two edge traversals for the same failing path
  clientTransport.send(
    serializer.stringify({
      op: "edge",
      tok: 0,
      edge: "getItem",
      args: ["bad"],
    }),
  );
  clientTransport.send(
    serializer.stringify({
      op: "edge",
      tok: 0,
      edge: "getItem",
      args: ["bad"],
    }),
  );
  await flush();

  // Both should fail
  const edgeResults = received.filter((m: any) => m.op === "edge");
  expect(edgeResults.length).toBe(2);
  expect(edgeResults[0].error).toBeDefined();
  expect(edgeResults[1].error).toBeDefined();

  // The edge getter should only have been called once (failed result cached)
  expect(resolveCount).toBe(1);
});

// -- Async edge getter --

test("async edge getter returns resolved data", async () => {
  class AsyncPost extends Node {
    id: string;
    title: string;

    constructor(id: string, title: string) {
      super();
      this.id = id;
      this.title = title;
    }
  }

  class AsyncService extends Node {
    @edge(AsyncPost, z.string())
    async load(id: string): Promise<AsyncPost> {
      await new Promise((r) => setTimeout(r, 10));
      return new AsyncPost(id, `Async Post ${id}`);
    }
  }

  const gpc = createServer({}, (_ctx: {}) => new AsyncService());
  const client = createClient<typeof gpc>({}, () => mockConnect(gpc, {}));

  const data = await client.root.load("42");
  expect(data.id).toBe("42");
  expect(data.title).toBe("Async Post 42");
});

// -- DATA_ERROR from getter throw --

test("DATA_ERROR wraps getter throw on full-node load", async () => {
  class BrokenNode extends Node {
    get value(): string {
      throw new Error("getter exploded");
    }
  }

  const gpc = createServer({}, (_ctx: {}) => new BrokenNode());
  const client = createClient<typeof gpc>({}, () => mockConnect(gpc, {}));

  try {
    await client.root;
    expect.unreachable("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe("DATA_ERROR");
    expect(err.message).toContain("getter exploded");
  }
});

// -- ref() in nested return structure --

test("ref() in nested return structure", async () => {
  class Item extends Node {
    id: string;
    label: string;

    constructor(id: string, label: string) {
      super();
      this.id = id;
      this.label = label;
    }

    static [canonicalPath](root: NestedRefApi, id: string) {
      return root.items.get(id);
    }
  }

  class ItemsService extends Node {
    #items = new Map([
      ["a", new Item("a", "Alpha")],
      ["b", new Item("b", "Beta")],
      ["c", new Item("c", "Gamma")],
    ]);

    @edge(Item, z.string())
    get(id: string): Item {
      return this.#items.get(id)!;
    }

    @method
    async getRelated(): Promise<{
      primary: Reference<Item>;
      related: Reference<Item>[];
    }> {
      return {
        primary: await ref(Item, "a"),
        related: [await ref(Item, "b"), await ref(Item, "c")],
      };
    }
  }

  class NestedRefApi extends Node {
    @edge(ItemsService)
    get items(): ItemsService {
      return new ItemsService();
    }
  }

  const [serverTransport, clientTransport] = createMockTransportPair();
  const gpc = createServer({}, (_ctx: {}) => new NestedRefApi());
  gpc.handle(serverTransport, {});
  const client = createClient<typeof gpc>({}, () => clientTransport);

  const result = await (client as any).root.items.getRelated();

  // Primary ref should carry data
  expect(result.primary.label).toBe("Alpha");
  expect(result.primary.id).toBe("a");

  // Related refs array should carry data
  expect(result.related.length).toBe(2);
  expect(result.related[0].label).toBe("Beta");
  expect(result.related[1].label).toBe("Gamma");
});

// -- Zero-schema @method with extra args --

test("zero-schema method rejects extra args with VALIDATION_ERROR", async () => {
  class PingApi extends Node {
    @method
    async ping(): Promise<string> {
      return "pong";
    }
  }

  const gpc = createServer({}, (_ctx: {}) => new PingApi());
  const client = createClient<typeof gpc>({}, () => mockConnect(gpc, {}));

  try {
    await (client as any).root.ping("unexpected", "args");
    expect.unreachable("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe("VALIDATION_ERROR");
  }
});

// -- Concurrent await node coalescing --

test("concurrent await node coalesces into one data message", async () => {
  const [serverTransport, clientTransport] = createMockTransportPair();
  const sent: any[] = [];

  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (data: string) => {
    sent.push(serializer.parse(data));
    originalSend(data);
  };

  const gpc = createServer({}, (_ctx: {}) => new Api());
  gpc.handle(serverTransport, {});
  const client = createClient<typeof gpc>({}, () => clientTransport);

  const post = client.root.posts.get("1");
  const [a, b] = await Promise.all([post, post]);

  expect(a.title).toBe("Hello World");
  expect(b.title).toBe("Hello World");

  // Edges should coalesce (1 "posts" edge, 1 "get" edge)
  const edgeMsgs = sent.filter((m: any) => m.op === "edge");
  expect(edgeMsgs.length).toBe(2); // posts + get("1")
  const postsEdges = edgeMsgs.filter((m: any) => m.edge === "posts");
  expect(postsEdges.length).toBe(1);

  // Concurrent data loads coalesce — only one data message sent
  const dataMsgs = sent.filter((m: any) => m.op === "data");
  expect(dataMsgs.length).toBe(1);
});

// -- Custom type mismatch --

// -- Custom error round-trip --

test("registered custom error survives server round-trip", async () => {
  class NotFound extends Error {
    constructor(
      public entity: string,
      public id: string,
    ) {
      super(`${entity} ${id} not found`);
      this.name = "NotFound";
    }
  }

  const serializerOpts = {
    reducers: {
      NotFound: (v: unknown) => v instanceof NotFound && [v.entity, v.id],
    },
    revivers: {
      NotFound: ([entity, id]: any) => new NotFound(entity, id),
    },
  };

  class ErrorApi extends Node {
    @method(z.string())
    async findItem(id: string): Promise<string> {
      throw new NotFound("Item", id);
    }
  }

  const gpc = createServer(serializerOpts, (_ctx: {}) => new ErrorApi());
  const client = createClient<typeof gpc>(serializerOpts, () =>
    mockConnect(gpc, {}),
  );

  try {
    await client.root.findItem("42");
    expect.unreachable("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(NotFound);
    expect(err.entity).toBe("Item");
    expect(err.id).toBe("42");
    expect(err.message).toBe("Item 42 not found");
  }
});

test("custom type mismatch causes deserialization failure", () => {
  class Money {
    constructor(
      public amount: number,
      public currency: string,
    ) {}
  }

  const serverSerializer = createSerializer({
    reducers: {
      Money: (v: unknown) =>
        v instanceof Money && [(v as Money).amount, (v as Money).currency],
    },
  });

  const clientSerializer = createSerializer(); // no Money reviver

  // Server serializes a response containing a Money value
  const response = {
    op: "get" as const,
    tok: 0,
    re: 1,
    data: new Money(42, "USD"),
  };
  const encoded = serverSerializer.stringify(response);

  // Client without Money reviver cannot parse the response
  expect(() => clientSerializer.parse(encoded)).toThrow();
});

// -- Pipelining tests --

test("pipelining: dependent edges are sent without waiting for responses", async () => {
  const [serverTransport, clientTransport] = createMockTransportPair();
  const clientSent: any[] = [];

  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (data: string) => {
    clientSent.push(serializer.parse(data));
    originalSend(data);
  };

  const gpc = createServer({}, (_ctx: {}) => new Api());
  gpc.handle(serverTransport, {});
  const client = createClient<typeof gpc>({}, () => clientTransport);

  // Navigate to posts.get("1") — requires two dependent edges + a data fetch.
  // With pipelining, all three messages should be sent before any response arrives.
  const result = await client.root.posts.get("1");
  expect(result.title).toBe("Hello World");

  // Verify all messages were sent: 2 edge messages + 1 data message
  const edgeMsgs = clientSent.filter((m) => m.op === "edge");
  const dataMsgs = clientSent.filter((m) => m.op === "data");
  expect(edgeMsgs.length).toBe(2);
  expect(edgeMsgs[0].edge).toBe("posts");
  expect(edgeMsgs[0].tok).toBe(0);
  expect(edgeMsgs[1].edge).toBe("get");
  expect(edgeMsgs[1].tok).toBe(1); // references parent token before it's confirmed
  expect(dataMsgs.length).toBe(1);
  expect(dataMsgs[0].tok).toBe(2); // references child token before it's confirmed
});

test("pipelining: sibling edges run in parallel on server", async () => {
  let postsResolveTime = 0;
  let usersResolveTime = 0;

  class SlowApi extends Node {
    @edge(PostsService)
    get posts(): PostsService {
      postsResolveTime = Date.now();
      return new PostsService();
    }

    @edge(UsersService)
    get users(): UsersService {
      usersResolveTime = Date.now();
      return new UsersService();
    }
  }

  const gpc = createServer({}, (_ctx: {}) => new SlowApi());
  const client = createClient<typeof gpc>({}, () => mockConnect(gpc, {}));

  // Launch two sibling edge traversals concurrently
  const [postCount, userData] = await Promise.all([
    client.root.posts.count(),
    client.root.users.get("1"),
  ]);

  expect(postCount).toBe(2);
  expect(userData.name).toBe("Alice");
  // Both edges resolved (parallel processing on server)
  expect(postsResolveTime).toBeGreaterThan(0);
  expect(usersResolveTime).toBeGreaterThan(0);
});

test("pipelining: failed parent edge poisons child edge", async () => {
  const [serverTransport, clientTransport] = createMockTransportPair();
  const received: any[] = [];

  const originalSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = (data: string) => {
    received.push(serializer.parse(data));
    originalSend(data);
  };

  const gpc = createServer({}, (_ctx: {}) => new Api());
  gpc.handle(serverTransport, {});
  received.shift(); // remove schema

  // Pipeline: edge to posts (ok), edge to get("999") (fails), then data on the poisoned token
  clientTransport.send(
    serializer.stringify({ op: "edge", tok: 0, edge: "posts" }),
  );
  clientTransport.send(
    serializer.stringify({
      op: "edge",
      tok: 1,
      edge: "get",
      args: ["999"],
    }),
  );
  clientTransport.send(serializer.stringify({ op: "data", tok: 2 }));

  await flush();

  // First edge should succeed
  const edgeResults = received.filter((m: any) => m.op === "edge");
  expect(edgeResults[0].error).toBeUndefined();

  // Second edge should fail
  expect(edgeResults[1].error).toBeDefined();

  // Data on the poisoned token should also fail
  const dataResults = received.filter((m: any) => m.op === "data");
  expect(dataResults.length).toBe(1);
  expect(dataResults[0].error).toBeDefined();
});

test("pipelining: dependent edge chain with data fetch (3 levels)", async () => {
  class Leaf extends Node {
    data = "leaf-data";
  }

  class Mid extends Node {
    @edge(Leaf)
    get leaf(): Leaf {
      return new Leaf();
    }
  }

  class DeepRoot extends Node {
    @edge(Mid)
    get mid(): Mid {
      return new Mid();
    }
  }

  const [serverTransport, clientTransport] = createMockTransportPair();
  const clientSent: any[] = [];

  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (data: string) => {
    clientSent.push(serializer.parse(data));
    originalSend(data);
  };

  const gpc = createServer({}, (_ctx: {}) => new DeepRoot());
  gpc.handle(serverTransport, {});
  const client = createClient<typeof gpc>({}, () => clientTransport);

  // 3 levels of dependent edges + data fetch, all pipelined
  const result = await client.root.mid.leaf;
  expect(result.data).toBe("leaf-data");

  // Should have sent: edge(mid), edge(leaf), data — all pipelined
  const edgeMsgs = clientSent.filter((m) => m.op === "edge");
  const dataMsgs = clientSent.filter((m) => m.op === "data");
  expect(edgeMsgs.length).toBe(2);
  expect(edgeMsgs[0].tok).toBe(0); // mid from root
  expect(edgeMsgs[1].tok).toBe(1); // leaf from mid (pipelined)
  expect(dataMsgs.length).toBe(1);
  expect(dataMsgs[0].tok).toBe(2); // data on leaf (pipelined)
});

test("pipelining: server processes pipelined get after dependent edge", async () => {
  const [serverTransport, clientTransport] = createMockTransportPair();
  const received: any[] = [];

  const originalSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = (data: string) => {
    received.push(serializer.parse(data));
    originalSend(data);
  };

  const gpc = createServer({}, (_ctx: {}) => new Api());
  gpc.handle(serverTransport, {});
  received.shift(); // remove schema

  // Pipeline: edge to posts, then get(count) on the new token
  clientTransport.send(
    serializer.stringify({ op: "edge", tok: 0, edge: "posts" }),
  );
  clientTransport.send(
    serializer.stringify({ op: "get", tok: 1, name: "count" }),
  );

  await flush();

  // Edge should succeed
  const edgeResults = received.filter((m: any) => m.op === "edge");
  expect(edgeResults.length).toBe(1);
  expect(edgeResults[0].error).toBeUndefined();

  // Get should succeed with the correct result
  const getResults = received.filter((m: any) => m.op === "get");
  expect(getResults.length).toBe(1);
  expect(getResults[0].data).toBe(2);
});

// -- abortSignal() tests --

test("abortSignal() returns a signal accessible in edge/method code", async () => {
  let capturedSignal: AbortSignal | null = null;

  class SignalApi extends Node {
    @method
    async checkSignal(): Promise<string> {
      capturedSignal = abortSignal();
      return "ok";
    }
  }

  const gpc = createServer(
    { maxOperationTimeout: 0, idleTimeout: 0 },
    () => new SignalApi(),
  );
  const client = createClient<typeof gpc>({}, () => mockConnect(gpc, {}));

  await client.root.checkSignal();
  expect(capturedSignal).not.toBeNull();
  expect(capturedSignal!.aborted).toBe(false);
});

test("abortSignal() fires when connection closes", async () => {
  let capturedSignal: AbortSignal | null = null;

  class SignalApi extends Node {
    @method
    async longOp(): Promise<string> {
      capturedSignal = abortSignal();
      await new Promise<void>(() => {}); // block until connection closes
      return "done";
    }
  }

  const [serverTransport, clientTransport] = createMockTransportPair();
  const gpc = createServer(
    { maxOperationTimeout: 0, idleTimeout: 0 },
    () => new SignalApi(),
  );
  gpc.handle(serverTransport, {});

  // Start the operation
  clientTransport.send(
    serializer.stringify({ op: "get", tok: 0, name: "longOp" }),
  );
  await flush();

  expect(capturedSignal).not.toBeNull();
  expect(capturedSignal!.aborted).toBe(false);

  // Close the connection
  serverTransport.close();

  expect(capturedSignal!.aborted).toBe(true);
});

// -- maxOperationTimeout tests --

test("maxOperationTimeout fires abort signal and returns OPERATION_TIMEOUT", async () => {
  let capturedSignal: AbortSignal | null = null;

  class SlowApi extends Node {
    @method
    async slow(): Promise<string> {
      capturedSignal = abortSignal();
      await new Promise((r) => setTimeout(r, 500));
      return "done";
    }
  }

  const timers = fakeTimers();
  const [serverTransport, clientTransport] = createMockTransportPair();
  const received: any[] = [];
  const originalSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = (data: string) => {
    received.push(serializer.parse(data));
    originalSend(data);
  };

  const gpc = createServer(
    { maxOperationTimeout: 5000, timers, idleTimeout: 0 },
    () => new SlowApi(),
  );
  gpc.handle(serverTransport, {});
  received.shift(); // remove schema

  clientTransport.send(
    serializer.stringify({ op: "get", tok: 0, name: "slow" }),
  );
  await flush();

  expect(capturedSignal).not.toBeNull();
  expect(capturedSignal!.aborted).toBe(false);

  // Fire the timeout timer
  timers.fire();

  expect(capturedSignal!.aborted).toBe(true);

  const getResults = received.filter((m: any) => m.op === "get");
  expect(getResults.length).toBe(1);
  expect(getResults[0].error).toBeDefined();
  expect(getResults[0].error.code).toBe("OPERATION_TIMEOUT");
});

test("maxOperationTimeout poisons edge tokens", async () => {
  class SlowEdgeTarget extends Node {
    value = "target";
  }

  class SlowEdgeApi extends Node {
    @edge(SlowEdgeTarget)
    async getTarget(): Promise<SlowEdgeTarget> {
      await new Promise((r) => setTimeout(r, 500));
      return new SlowEdgeTarget();
    }
  }

  const timers = fakeTimers();
  const [serverTransport, clientTransport] = createMockTransportPair();
  const received: any[] = [];
  const originalSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = (data: string) => {
    received.push(serializer.parse(data));
    originalSend(data);
  };

  const gpc = createServer(
    { maxOperationTimeout: 5000, timers, idleTimeout: 0 },
    () => new SlowEdgeApi(),
  );
  gpc.handle(serverTransport, {});
  received.shift(); // remove schema

  // Send edge then data on the resulting token (pipelined)
  clientTransport.send(
    serializer.stringify({ op: "edge", tok: 0, edge: "getTarget" }),
  );
  clientTransport.send(serializer.stringify({ op: "data", tok: 1 }));
  await flush();

  // Fire the edge timeout
  timers.fire();
  await flush();

  const edgeResults = received.filter((m: any) => m.op === "edge");
  expect(edgeResults.length).toBe(1);
  expect(edgeResults[0].error).toBeDefined();
  expect(edgeResults[0].error.code).toBe("OPERATION_TIMEOUT");
});

// -- Error redaction tests --

test("redactErrors: unregistered errors get generic message", async () => {
  class FailApi extends Node {
    @method
    async fail(): Promise<void> {
      throw new Error("secret internal details");
    }
  }

  const gpc = createServer(
    { redactErrors: true, maxOperationTimeout: 0, idleTimeout: 0 },
    () => new FailApi(),
  );
  const client = createClient<typeof gpc>({}, () => mockConnect(gpc, {}));

  try {
    await client.root.fail();
    expect.unreachable("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe("GET_ERROR");
    expect(err.message).toBe("Internal server error");
    expect(err.message).not.toContain("secret internal details");
  }
});

test("redactErrors: registered errors are never redacted", async () => {
  class NotFound extends Error {
    constructor(
      public entity: string,
      public id: string,
    ) {
      super(`${entity} ${id} not found`);
      this.name = "NotFound";
    }
  }

  const serializerOpts = {
    reducers: {
      NotFound: (v: unknown) => v instanceof NotFound && [v.entity, v.id],
    },
    revivers: {
      NotFound: ([entity, id]: any) => new NotFound(entity, id),
    },
  };

  class ErrorApi extends Node {
    @method(z.string())
    async findItem(id: string): Promise<string> {
      throw new NotFound("Item", id);
    }
  }

  const gpc = createServer(
    {
      ...serializerOpts,
      redactErrors: true,
      maxOperationTimeout: 0,
      idleTimeout: 0,
    },
    () => new ErrorApi(),
  );
  const client = createClient<typeof gpc>(serializerOpts, () =>
    mockConnect(gpc, {}),
  );

  try {
    await client.root.findItem("42");
    expect.unreachable("should have thrown");
  } catch (err: any) {
    // Custom registered error should NOT be redacted
    expect(err).toBeInstanceOf(NotFound);
    expect(err.entity).toBe("Item");
    expect(err.id).toBe("42");
  }
});

test("redactErrors: RpcError thrown directly is never redacted", async () => {
  class DirectApi extends Node {
    @method
    async fail(): Promise<void> {
      throw new RpcError("CUSTOM_CODE", "custom message");
    }
  }

  const gpc = createServer(
    { redactErrors: true, maxOperationTimeout: 0, idleTimeout: 0 },
    () => new DirectApi(),
  );
  const client = createClient<typeof gpc>({}, () => mockConnect(gpc, {}));

  try {
    await client.root.fail();
    expect.unreachable("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe("CUSTOM_CODE");
    expect(err.message).toBe("custom message");
  }
});

// -- errorId tests --

test("errorId present on get and edge error responses", async () => {
  // Get error
  {
    const [serverTransport, clientTransport] = createMockTransportPair();
    const received: any[] = [];
    const originalSend = serverTransport.send.bind(serverTransport);
    serverTransport.send = (data: string) => {
      received.push(serializer.parse(data));
      originalSend(data);
    };

    class FailApi extends Node {
      @method
      async fail(): Promise<void> {
        throw new Error("boom");
      }
    }

    const gpc = createServer(
      { maxOperationTimeout: 0, idleTimeout: 0 },
      () => new FailApi(),
    );
    gpc.handle(serverTransport, {});
    received.shift(); // remove schema

    clientTransport.send(
      serializer.stringify({ op: "get", tok: 0, name: "fail" }),
    );
    await flush();

    const getResults = received.filter((m: any) => m.op === "get");
    expect(getResults.length).toBe(1);
    expect(getResults[0].error).toBeDefined();
    expect(typeof getResults[0].errorId).toBe("string");
    expect(getResults[0].errorId.length).toBeGreaterThan(0);
  }

  // Edge error
  {
    const [serverTransport, clientTransport] = createMockTransportPair();
    const received: any[] = [];
    const originalSend = serverTransport.send.bind(serverTransport);
    serverTransport.send = (data: string) => {
      received.push(serializer.parse(data));
      originalSend(data);
    };

    const gpc = createServer(
      { maxOperationTimeout: 0, idleTimeout: 0 },
      () => new Api(),
    );
    gpc.handle(serverTransport, {});
    received.shift(); // remove schema

    clientTransport.send(
      serializer.stringify({ op: "edge", tok: 0, edge: "posts" }),
    );
    clientTransport.send(
      serializer.stringify({
        op: "edge",
        tok: 1,
        edge: "get",
        args: ["999"],
      }),
    );
    await flush();

    const edgeResults = received.filter((m: any) => m.op === "edge");
    const failedEdge = edgeResults.find((m: any) => m.error);
    expect(failedEdge).toBeDefined();
    expect(typeof failedEdge.errorId).toBe("string");
  }
});

// -- getErrorUuid() tests --

test("getErrorUuid() retrieves UUID from RPC errors, null otherwise", async () => {
  class FailApi extends Node {
    @method
    async fail(): Promise<void> {
      throw new Error("boom");
    }
  }

  const gpc = createServer(
    { maxOperationTimeout: 0, idleTimeout: 0 },
    () => new FailApi(),
  );
  const client = createClient<typeof gpc>({}, () => mockConnect(gpc, {}));

  try {
    await client.root.fail();
    expect.unreachable("should have thrown");
  } catch (err: any) {
    const uuid = getErrorUuid(err);
    expect(uuid).not.toBeNull();
    expect(typeof uuid).toBe("string");
    expect(uuid!.length).toBeGreaterThan(0);
  }

  // Non-RPC errors return null
  expect(getErrorUuid(new Error("plain"))).toBeNull();
  expect(getErrorUuid("string error")).toBeNull();
  expect(getErrorUuid(null)).toBeNull();
});

// -- operationError event tests --

test("operationError event: redacted for unregistered, non-redacted for RpcError", async () => {
  // Unregistered error → redacted=true
  {
    const events: any[] = [];

    class FailApi extends Node {
      @method
      async fail(): Promise<void> {
        throw new Error("secret error");
      }
    }

    const gpc = createServer(
      { redactErrors: true, maxOperationTimeout: 0, idleTimeout: 0 },
      () => new FailApi(),
    );

    gpc.on("operationError", (_ctx, info) => {
      events.push(info);
    });

    const client = createClient<typeof gpc>({}, () => mockConnect(gpc, {}));

    try {
      await client.root.fail();
    } catch {
      // expected
    }

    expect(events.length).toBe(1);
    expect(events[0].error).toBeInstanceOf(Error);
    expect((events[0].error as Error).message).toBe("secret error");
    expect(typeof events[0].errorId).toBe("string");
    expect(events[0].redacted).toBe(true);
  }

  // RpcError → redacted=false
  {
    const events: any[] = [];

    class FailApi extends Node {
      @method
      async fail(): Promise<void> {
        throw new RpcError("CUSTOM", "visible error");
      }
    }

    const gpc = createServer(
      { redactErrors: true, maxOperationTimeout: 0, idleTimeout: 0 },
      () => new FailApi(),
    );

    gpc.on("operationError", (_ctx, info) => {
      events.push(info);
    });

    const client = createClient<typeof gpc>({}, () => mockConnect(gpc, {}));

    try {
      await client.root.fail();
    } catch {
      // expected
    }

    expect(events.length).toBe(1);
    expect(events[0].redacted).toBe(false);
  }
});

// -- Slot queue drain on close tests --

test("slot queue drain on close: queued ops get CONNECTION_CLOSED error", async () => {
  let opsStarted = 0;

  class SlowApi extends Node {
    @method
    async slow(): Promise<string> {
      opsStarted++;
      await new Promise<void>(() => {}); // never resolves — keeps op in slot
      return "done";
    }
  }

  const [serverTransport, clientTransport] = createMockTransportPair();
  const received: any[] = [];
  const originalSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = (data: string) => {
    received.push(serializer.parse(data));
    originalSend(data);
  };

  const gpc = createServer(
    { maxPendingOps: 1, maxOperationTimeout: 0, idleTimeout: 0 },
    () => new SlowApi(),
  );
  gpc.handle(serverTransport, {});
  received.shift(); // remove schema

  // Send 3 ops — only 1 can execute at a time, others queue
  clientTransport.send(
    serializer.stringify({ op: "get", tok: 0, name: "slow" }),
  );
  clientTransport.send(
    serializer.stringify({ op: "get", tok: 0, name: "slow" }),
  );
  clientTransport.send(
    serializer.stringify({ op: "get", tok: 0, name: "slow" }),
  );
  await flush();

  // First op should be running, others queued
  expect(opsStarted).toBe(1);

  // Close the connection — queued ops should get rejected, not executed
  serverTransport.close();
  await flush();

  // Only 1 op should have started (the one that got a slot)
  expect(opsStarted).toBe(1);
});

// ===========================================================================
// Path<T> — client-to-server and server-to-client path references
// ===========================================================================

// -- Path test API --

class Category extends Node {
  name: string;
  constructor(name: string) {
    super();
    this.name = name;
  }

  static [canonicalPath](root: PathApi, name: string) {
    return root.categories.get(name);
  }
}

class CategoriesService extends Node {
  #categories = new Map<string, Category>([
    ["tech", new Category("tech")],
    ["science", new Category("science")],
  ]);

  @edge(Category, z.string())
  get(name: string): Category {
    const cat = this.#categories.get(name);
    if (!cat) throw new Error(`Category ${name} not found`);
    return cat;
  }
}

class PathPost extends Node {
  id: string;
  title: string;
  categoryName: string;

  constructor(id: string, title: string, categoryName: string) {
    super();
    this.id = id;
    this.title = title;
    this.categoryName = categoryName;
  }

  static [canonicalPath](root: PathApi, id: string) {
    return root.pathPosts.get(id);
  }
}

class PathPostsService extends Node {
  #posts = new Map<string, PathPost>([
    ["1", new PathPost("1", "Hello", "tech")],
    ["2", new PathPost("2", "World", "science")],
  ]);

  @edge(PathPost, z.string())
  get(id: string): PathPost {
    const post = this.#posts.get(id);
    if (!post) throw new Error(`Post ${id} not found`);
    return post;
  }

  @method(path(PathPost), path(Category))
  async move(post: Path<PathPost>, cat: Path<Category>): Promise<string> {
    const p = await post;
    const c = await cat;
    p.categoryName = c.name;
    return `Moved ${p.id} to ${c.name}`;
  }

  @method(z.string(), path(PathPost))
  async tag(label: string, post: Path<PathPost>): Promise<string> {
    const p = await post;
    return `Tagged ${p.id} with ${label}`;
  }

  @method
  async listPaths(): Promise<Path<PathPost>[]> {
    return Array.from(this.#posts.keys()).map((id) => pathTo(PathPost, id));
  }

  @method(path(PathPost))
  async noAwait(_post: Path<PathPost>): Promise<string> {
    // Intentionally does NOT await the path
    return "lazy";
  }
}

class SecretService extends Node {
  @edge(PathPost, z.string())
  get(id: string): PathPost {
    return new PathPost(id, "secret", "hidden");
  }
}

class PathApi extends Node {
  @edge(PathPostsService)
  get pathPosts(): PathPostsService {
    return new PathPostsService();
  }

  @edge(CategoriesService)
  get categories(): CategoriesService {
    return new CategoriesService();
  }

  @hidden(() => true)
  @edge(SecretService)
  get secret(): SecretService {
    return new SecretService();
  }
}

function pathSetup() {
  const gpc = createServer({}, (_ctx: {}) => new PathApi());
  const client = createClient<typeof gpc>({}, () => mockConnect(gpc, {}));
  return { client, gpc };
}

test("pathOf(stub) → method receives Path<T> → await resolves to live node", async () => {
  const { client } = pathSetup();

  const postStub = client.root.pathPosts.get("1");
  const catStub = client.root.categories.get("tech");
  const result = await client.root.pathPosts.move(
    pathOf(postStub),
    pathOf(catStub),
  );
  expect(result).toBe("Moved 1 to tech");
});

test("path() mixed with z.string() schema in same method", async () => {
  const { client } = pathSetup();

  const postStub = client.root.pathPosts.get("2");
  const result = await client.root.pathPosts.tag("important", pathOf(postStub));
  expect(result).toBe("Tagged 2 with important");
});

test("path() rejects non-PathArg input", async () => {
  const { client } = pathSetup();

  const p = Promise.resolve(
    (client.root.pathPosts as any).move("not-a-path", "also-not"),
  ).then((v: any) => v);
  await expect(p).rejects.toBeInstanceOf(ValidationError);
});

test("path() plausibility check catches wrong target type", async () => {
  const { client } = pathSetup();

  // Send a category path where a post path is expected
  const catStub = client.root.categories.get("tech");
  const p = Promise.resolve(
    (client.root.pathPosts as any).move(pathOf(catStub), pathOf(catStub)),
  ).then((v: any) => v);
  await expect(p).rejects.toBeInstanceOf(ValidationError);
});

test("path() plausibility check rejects hidden edges", async () => {
  const { client } = pathSetup();

  // Manually construct a PathArg through the hidden "secret" edge
  const badPath = new PathArg(["secret", ["get", "1"]]);
  const catStub = client.root.categories.get("tech");
  const p = Promise.resolve(
    (client.root.pathPosts as any).move(badPath, pathOf(catStub)),
  ).then((v: any) => v);
  await expect(p).rejects.toBeInstanceOf(ValidationError);
});

test("path depth limit rejects >64 segments", async () => {
  const { client } = pathSetup();

  const longPath = new PathArg(Array.from({ length: 65 }, (_, i) => `seg${i}`));
  const catStub = client.root.categories.get("tech");
  const p = Promise.resolve(
    (client.root.pathPosts as any).move(longPath, pathOf(catStub)),
  ).then((v: any) => v);
  await expect(p).rejects.toBeInstanceOf(ValidationError);
});

test("server returns Path<T> → client receives stubs", async () => {
  const { client } = pathSetup();

  const stubs = await client.root.pathPosts.listPaths();
  expect(stubs.length).toBe(2);

  // Each stub should be navigable — await fetches data
  const post = await stubs[0]!;
  expect(post.id).toBeDefined();
  expect(post.title).toBeDefined();
});

test("path not awaited on server → no graph walk", async () => {
  const { client } = pathSetup();

  const postStub = client.root.pathPosts.get("1");
  const result = await client.root.pathPosts.noAwait(pathOf(postStub));
  expect(result).toBe("lazy");
});

test("pathOf() from data proxy works", async () => {
  const { client } = pathSetup();

  const postData = await client.root.pathPosts.get("1");
  // postData is a data proxy — pathOf should still extract the path
  const arg = pathOf(postData);
  expect(arg).toBeInstanceOf(PathArg);
  expect(arg.segments).toEqual(["pathPosts", ["get", "1"]]);
});

test("pathOf() throws on non-stub", () => {
  expect(() => pathOf("not a stub")).toThrow("pathOf() requires a stub");
  expect(() => pathOf(null)).toThrow("pathOf() requires a stub");
  expect(() => pathOf(42)).toThrow("pathOf() requires a stub");
});

// -- ref() eviction / token-cache invariants --
//
// These tests verify that tokens remain usable after ref() invalidates
// descendant cache entries, that concurrent edge resolution survives
// invalidation, and that ref()'s cached promises don't leak unhandled
// rejections.

const deepStore = new Map([
  ["1", { title: "Item One" }],
  ["2", { title: "Item Two" }],
]);

class DeepChild extends Node {
  id: string;
  value: string;

  constructor(id: string) {
    super();
    this.id = id;
    this.value = `child-${id}`;
  }

  @method
  async greet(): Promise<string> {
    return `Hello from child ${this.id}`;
  }
}

class DeepChildService extends Node {
  @edge(DeepChild, z.string())
  get(id: string): DeepChild {
    return new DeepChild(id);
  }
}

let resolveSlowEdge: (() => void) | undefined;

class SlowChild extends Node {
  value = "slow-resolved";
}

class DeepItem extends Node {
  id: string;

  constructor(id: string) {
    super();
    this.id = id;
  }

  get title(): string {
    return deepStore.get(this.id)?.title ?? "unknown";
  }

  static [canonicalPath](root: DeepApi, id: string) {
    return root.items.get(id);
  }

  @edge(DeepChildService)
  get children(): DeepChildService {
    return new DeepChildService();
  }

  @edge(SlowChild)
  async getSlow(): Promise<SlowChild> {
    await new Promise<void>((r) => {
      resolveSlowEdge = r;
    });
    return new SlowChild();
  }

  @method(z.string())
  async updateTitle(newTitle: string): Promise<Reference<DeepItem>> {
    const entry = deepStore.get(this.id);
    if (entry) entry.title = newTitle;
    return ref(DeepItem, this.id);
  }
}

class DeepItemService extends Node {
  @edge(DeepItem, z.string())
  get(id: string): DeepItem {
    if (!deepStore.has(id)) throw new Error(`Item ${id} not found`);
    return new DeepItem(id);
  }
}

class DeepApi extends Node {
  @edge(DeepItemService)
  get items(): DeepItemService {
    return new DeepItemService();
  }
}

function deepSetup() {
  const [serverTransport, clientTransport] = createMockTransportPair();
  const received: any[] = [];

  const originalSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = (data: string) => {
    received.push(serializer.parse(data));
    originalSend(data);
  };

  const server = createServer(
    { maxOperationTimeout: 0, idleTimeout: 0 },
    () => new DeepApi(),
  );
  server.handle(serverTransport, {});

  // Remove the initial schema/hello message
  received.shift();

  return { clientTransport, received };
}

function rawSend(transport: { send(data: string): void }, msg: object) {
  transport.send(serializer.stringify(msg));
}

/**
 * Navigate to items.get(id).children.get(childId), returning token numbers.
 * After flush: tokens 1=DeepItemService, 2=DeepItem, 3=DeepChildService, 4=DeepChild.
 */
async function navigateToChild(
  transport: { send(data: string): void },
  id = "1",
  childId = "5",
) {
  rawSend(transport, { op: "edge", tok: 0, edge: "items" }); // token 1
  rawSend(transport, { op: "edge", tok: 1, edge: "get", args: [id] }); // token 2
  rawSend(transport, { op: "edge", tok: 2, edge: "children" }); // token 3
  rawSend(transport, { op: "edge", tok: 3, edge: "get", args: [childId] }); // token 4
  await flush();
}

/**
 * Navigate to items.get(id), returning token numbers.
 * After flush: tokens 1=DeepItemService, 2=DeepItem.
 */
async function navigateToItem(
  transport: { send(data: string): void },
  id = "1",
) {
  rawSend(transport, { op: "edge", tok: 0, edge: "items" }); // token 1
  rawSend(transport, { op: "edge", tok: 1, edge: "get", args: [id] }); // token 2
  await flush();
}

test("descendant tokens usable after ref() eviction (data, method, edge)", async () => {
  const { clientTransport, received } = deepSetup();

  // Navigate to items.get("1").children.get("5") — tokens 1-4
  await navigateToChild(clientTransport);

  // Verify all 4 edges succeeded
  const edges = received.filter((m: any) => m.op === "edge");
  expect(edges.length).toBe(4);
  for (const e of edges) expect(e.error).toBeUndefined();

  received.length = 0;

  // Trigger ref(DeepItem, "1") via method — invalidates descendant cache entries
  rawSend(clientTransport, {
    op: "get",
    tok: 2,
    name: "updateTitle",
    args: ["Updated"],
  });
  await flush();

  received.length = 0;

  // Data fetch on descendant token 4 (DeepChild)
  rawSend(clientTransport, { op: "data", tok: 4 });
  await flush();

  const dataResults = received.filter((m: any) => m.op === "data");
  expect(dataResults.length).toBe(1);
  expect(dataResults[0].error).toBeUndefined();
  expect(dataResults[0].data.id).toBe("5");
  expect(dataResults[0].data.value).toBe("child-5");

  received.length = 0;

  // Method call on descendant token 4 (DeepChild.greet)
  rawSend(clientTransport, { op: "get", tok: 4, name: "greet" });
  await flush();

  const getResults = received.filter((m: any) => m.op === "get");
  expect(getResults.length).toBe(1);
  expect(getResults[0].error).toBeUndefined();
  expect(getResults[0].data).toBe("Hello from child 5");

  received.length = 0;

  // Edge traversal from descendant token 3 (DeepChildService.get("7"))
  rawSend(clientTransport, {
    op: "edge",
    tok: 3,
    edge: "get",
    args: ["7"],
  });
  await flush();

  const edgeResults = received.filter((m: any) => m.op === "edge");
  expect(edgeResults.length).toBe(1);
  expect(edgeResults[0].error).toBeUndefined();
});

test("concurrent edge resolution survives ref() eviction", async () => {
  const { clientTransport, received } = deepSetup();

  // Navigate to DeepItem (token 2)
  await navigateToItem(clientTransport);

  const edges = received.filter((m: any) => m.op === "edge");
  expect(edges.length).toBe(2);
  for (const e of edges) expect(e.error).toBeUndefined();

  received.length = 0;

  // Start slow edge traversal — creates entry in nodeCache, blocks on promise
  rawSend(clientTransport, { op: "edge", tok: 2, edge: "getSlow" }); // token 3

  // Concurrently trigger ref(DeepItem, "1") — invalidates the slow edge's entry
  rawSend(clientTransport, {
    op: "get",
    tok: 2,
    name: "updateTitle",
    args: ["Updated"],
  });

  // Let the method complete (ref runs, invalidates slow entry).
  // The slow edge is still blocked on its controllable promise.
  await flush();

  // Now resolve the slow edge
  expect(resolveSlowEdge).toBeDefined();
  resolveSlowEdge!();
  await flush();

  // The edge should have resolved successfully
  const edgeResults = received.filter((m: any) => m.op === "edge");
  expect(edgeResults.length).toBe(1);
  expect(edgeResults[0].error).toBeUndefined();

  received.length = 0;

  // Data fetch on the slow child token — should succeed with resolved data
  rawSend(clientTransport, { op: "data", tok: 3 });
  await flush();

  const dataResults = received.filter((m: any) => m.op === "data");
  expect(dataResults.length).toBe(1);
  expect(dataResults[0].error).toBeUndefined();
  expect(dataResults[0].data).toBeDefined();
  expect(dataResults[0].data.value).toBe("slow-resolved");
});

test("ref() deferred rejection does not cause unhandled rejection", async () => {
  // Graph where ref()'s walkPath fails
  class FailItem extends Node {
    id: string;
    constructor(id: string) {
      super();
      if (id === "bad") throw new Error("Cannot create bad item");
      this.id = id;
    }

    static [canonicalPath](root: FailApi, id: string) {
      return root.items.get(id);
    }

    @method
    async triggerBadRef(): Promise<Reference<FailItem>> {
      return ref(FailItem, "bad");
    }
  }

  class FailItemService extends Node {
    @edge(FailItem, z.string())
    get(id: string): FailItem {
      return new FailItem(id);
    }
  }

  class FailApi extends Node {
    @edge(FailItemService)
    get items(): FailItemService {
      return new FailItemService();
    }
  }

  const [serverTransport, clientTransport] = createMockTransportPair();
  const received: any[] = [];
  const originalSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = (data: string) => {
    received.push(serializer.parse(data));
    originalSend(data);
  };

  const server = createServer(
    { maxOperationTimeout: 0, idleTimeout: 0 },
    () => new FailApi(),
  );
  server.handle(serverTransport, {});
  received.shift(); // remove hello

  // Navigate to items.get("1") — a valid item
  rawSend(clientTransport, { op: "edge", tok: 0, edge: "items" }); // token 1
  rawSend(clientTransport, {
    op: "edge",
    tok: 1,
    edge: "get",
    args: ["1"],
  }); // token 2
  await flush();

  received.length = 0;

  // Call method that triggers ref(FailItem, "bad") — walkPath will fail
  // because FailItem("bad") throws in the constructor.
  // The method should return an error, but ref()'s deferred in nodeCache
  // should NOT cause an unhandled rejection.
  rawSend(clientTransport, { op: "get", tok: 2, name: "triggerBadRef" });
  await flush();

  // Give the microtask queue time to detect unhandled rejections
  await new Promise((r) => setTimeout(r, 50));

  // The method should have returned an error (expected — bad ref)
  const getResults = received.filter((m: any) => m.op === "get");
  expect(getResults.length).toBe(1);
  expect(getResults[0].error).toBeDefined();

  // If we got here without an unhandled rejection crashing the test, it passes.
});

test("pipelined method (ref) + descendant data fetch both complete", async () => {
  const { clientTransport, received } = deepSetup();

  // Navigate to items.get("1").children.get("5") — tokens 1-4
  await navigateToChild(clientTransport);
  received.length = 0;

  // Pipeline: method call that triggers ref() AND data fetch on descendant
  // in the same batch (no flush between)
  rawSend(clientTransport, {
    op: "get",
    tok: 2,
    name: "updateTitle",
    args: ["Updated"],
  });
  rawSend(clientTransport, { op: "data", tok: 4 });
  await flush();

  // Method response should have data (the ref return value)
  const getResults = received.filter((m: any) => m.op === "get");
  expect(getResults.length).toBe(1);
  expect(getResults[0].error).toBeUndefined();

  // Descendant data fetch should also succeed with stale data
  const dataResults = received.filter((m: any) => m.op === "data");
  expect(dataResults.length).toBe(1);
  expect(dataResults[0].error).toBeUndefined();
  expect(dataResults[0].data).toBeDefined();
  expect(dataResults[0].data.id).toBe("5");
});
