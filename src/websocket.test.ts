import { test, expect } from "bun:test";
import { z } from "zod";
import { createClient } from "./client.ts";
import { edge, method } from "./decorators.ts";
import { eventDataToString } from "./protocol.ts";
import { createServer } from "./server.ts";
import { flush, mockConnect } from "./test-utils.ts";
import { Node } from "./types.ts";
import type { WsLike } from "./types.ts";

// -- Test API --

class Post extends Node {
  id: string;
  title: string;

  constructor(id: string, title: string) {
    super();
    this.id = id;
    this.title = title;
  }

  @method(z.string())
  async updateTitle(title: string): Promise<void> {
    this.title = title;
  }
}

class PostsService extends Node {
  #posts = new Map<string, Post>([
    ["1", new Post("1", "Hello World")],
    ["2", new Post("2", "Second Post")],
  ]);

  @edge(Post, z.string())
  get(id: string): Post {
    const post = this.#posts.get(id);
    if (!post) throw new Error(`Post ${id} not found`);
    return post;
  }

  @method
  async count(): Promise<number> {
    return this.#posts.size;
  }
}

class Api extends Node {
  @edge(PostsService)
  get posts(): PostsService {
    return new PostsService();
  }

  @method
  async ping(): Promise<string> {
    return "pong";
  }
}

// -- eventDataToString --

test("eventDataToString: string passthrough", () => {
  expect(eventDataToString("hello")).toBe("hello");
});

test("eventDataToString: Uint8Array", () => {
  const data = new TextEncoder().encode('{"op":"data"}');
  expect(eventDataToString(data)).toBe('{"op":"data"}');
});

test("eventDataToString: ArrayBuffer", () => {
  const encoder = new TextEncoder();
  const data = encoder.encode('{"op":"edge"}').buffer;
  expect(eventDataToString(data)).toBe('{"op":"edge"}');
});

// -- mockConnect --

test("mockConnect: basic end-to-end", async () => {
  const server = createServer({}, () => new Api());
  const client = createClient<typeof server>({}, () => mockConnect(server, {}));

  const result = await client.root.ping();
  expect(result).toBe("pong");
});

test("mockConnect: deep navigation", async () => {
  const server = createServer({}, () => new Api());
  const client = createClient<typeof server>({}, () => mockConnect(server, {}));

  const post = await client.root.posts.get("1");
  expect(post.title).toBe("Hello World");
});

// -- wsHandlers --

/** Mock Bun ServerWebSocket */
function createMockWs<T>(
  data: T,
): WsLike<T> & { sent: string[]; closed: boolean } {
  const ws = {
    data,
    sent: [] as string[],
    closed: false,
    send(msg: string) {
      ws.sent.push(msg);
    },
    close() {
      ws.closed = true;
    },
  };
  return ws;
}

test("wsHandlers: end-to-end with mock Bun ws", async () => {
  const server = createServer({}, () => new Api());
  const handlers = server.wsHandlers<{ userId: string }>((data) => data);

  const ws = createMockWs({ userId: "user1" });

  // Simulate open — triggers hello message (message 0)
  handlers.open(ws);
  expect(ws.sent.length).toBe(1); // hello message

  // Hello was sent
  expect(ws.sent.length).toBeGreaterThan(0);

  // Simulate close
  handlers.close(ws);
});

test("wsHandlers: message and response flow", async () => {
  const server = createServer({}, () => new Api());
  const handlers = server.wsHandlers<{}>((data) => data);

  const ws = createMockWs({});
  handlers.open(ws);

  // Clear the schema message
  ws.sent.shift();

  // Import serializer to create proper wire messages
  const { createSerializer } = await import("./serialization.ts");
  const serializer = createSerializer();

  // Send a data request for root (token 0)
  handlers.message(ws, serializer.stringify({ op: "data", tok: 0 }));
  await flush();

  // Should have received a data response
  expect(ws.sent.length).toBe(1);
  const response = serializer.parse(ws.sent[0]!) as any;
  expect(response.op).toBe("data");
  expect(response.re).toBe(1);

  handlers.close(ws);
});

test("wsHandlers: handles ArrayBuffer messages", async () => {
  const server = createServer({}, () => new Api());
  const handlers = server.wsHandlers<{}>((data) => data);

  const ws = createMockWs({});
  handlers.open(ws);
  ws.sent.shift(); // clear schema

  const { createSerializer } = await import("./serialization.ts");
  const serializer = createSerializer();

  // Send message as ArrayBuffer (like Bun might deliver binary frames)
  const msgStr = serializer.stringify({ op: "data", tok: 0 });
  const encoded = new TextEncoder().encode(msgStr);
  handlers.message(ws, encoded);
  await flush();

  expect(ws.sent.length).toBe(1);
  const response = serializer.parse(ws.sent[0]!) as any;
  expect(response.op).toBe("data");
});

test("wsHandlers: error handler routes to server error emitter", async () => {
  const server = createServer({}, () => new Api());
  const handlers = server.wsHandlers<{}>((data) => data);

  const errors: unknown[] = [];
  server.on("error", (err) => errors.push(err));

  const ws = createMockWs({});
  const testError = new Error("test error");
  handlers.error(ws, testError);

  expect(errors.length).toBe(1);
  expect(errors[0]).toBe(testError);
});

test("wsHandlers: close cleans up WeakMap (no crash on double close)", () => {
  const server = createServer({}, () => new Api());
  const handlers = server.wsHandlers<{}>((data) => data);

  const ws = createMockWs({});
  handlers.open(ws);
  handlers.close(ws);
  // Second close should be a no-op (WeakMap entry deleted)
  handlers.close(ws);
});

test("wsHandlers: multiple concurrent connections", async () => {
  const server = createServer({}, () => new Api());
  const handlers = server.wsHandlers<{ id: string }>((data) => data);

  const ws1 = createMockWs({ id: "1" });
  const ws2 = createMockWs({ id: "2" });

  handlers.open(ws1);
  handlers.open(ws2);

  // Both should receive schema
  expect(ws1.sent.length).toBe(1);
  expect(ws2.sent.length).toBe(1);

  const { createSerializer } = await import("./serialization.ts");
  const serializer = createSerializer();

  // Send data request on ws1 only
  ws1.sent.shift();
  ws2.sent.shift();
  handlers.message(ws1, serializer.stringify({ op: "data", tok: 0 }));
  await flush();

  expect(ws1.sent.length).toBe(1);
  expect(ws2.sent.length).toBe(0); // ws2 should not receive ws1's response

  handlers.close(ws1);
  handlers.close(ws2);
});
