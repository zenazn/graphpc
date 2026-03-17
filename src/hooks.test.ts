import { test, expect } from "bun:test";
import { z } from "zod";
import { createClient } from "./client";
import { getContext, abortSignal, abortThisConn } from "./context";
import { edge, method } from "./decorators";
import { RpcError } from "./errors";
import type { OperationInfo, OperationResult } from "./hooks";
import { createMockTransportPair } from "./protocol";
import { createServer } from "./server";
import { flush, mockConnect } from "./test-utils";
import { Node } from "./types";

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
  @edge(Post, z.string())
  get(id: string): Post {
    return new Post(id, `Post ${id}`);
  }

  @method
  async count(): Promise<number> {
    return 42;
  }
}

class Api extends Node {
  value = "hello";

  @edge(PostsService)
  get posts(): PostsService {
    return new PostsService();
  }

  @method
  async ping(): Promise<string> {
    return "pong";
  }
}

// -- connection event --

test("connection event fires on connect, disconnect fires on close", async () => {
  let connected = false;
  let disconnected = false;

  const [st, ct] = createMockTransportPair();
  const server = createServer({}, () => new Api());
  server.on("connection", () => {
    connected = true;
  });
  server.on("disconnect", () => {
    disconnected = true;
  });
  server.handle(st, {});

  expect(connected).toBe(true);
  expect(disconnected).toBe(false);

  // Close the transport
  ct.close();
  await flush();

  expect(disconnected).toBe(true);
});

test("connection and disconnect events receive context", async () => {
  let connCtx: unknown;
  let disconnCtx: unknown;

  const [st, ct] = createMockTransportPair();
  const server = createServer({}, () => new Api());
  server.on("connection", (ctx) => {
    connCtx = ctx;
  });
  server.on("disconnect", (ctx) => {
    disconnCtx = ctx;
  });
  server.handle(st, { userId: "u1" });

  expect(connCtx).toEqual({ userId: "u1" });

  ct.close();
  await flush();

  expect(disconnCtx).toEqual({ userId: "u1" });
});

test("connection handler error emits error event, doesn't crash server", async () => {
  const errors: unknown[] = [];

  const server = createServer({}, () => new Api());
  server.on("connection", () => {
    throw new Error("hook boom");
  });
  server.on("error", (err) => errors.push(err));
  const client = createClient<typeof server>({}, () => mockConnect(server, {}));

  // Should still work despite connection handler error
  const result = await client.root.ping();
  expect(result).toBe("pong");
  expect(errors.length).toBe(1);
  expect((errors[0] as Error).message).toBe("hook boom");
});

test("disconnect handler error emits error event", async () => {
  const errors: unknown[] = [];

  const [st, ct] = createMockTransportPair();
  const server = createServer({}, () => new Api());
  server.on("disconnect", () => {
    throw new Error("disconnect boom");
  });
  server.on("error", (err) => errors.push(err));
  server.handle(st, {});

  ct.close();
  await flush();

  expect(errors.length).toBe(1);
  expect((errors[0] as Error).message).toBe("disconnect boom");
});

// -- operation event --

test("operation event wraps edge ops with correct OperationInfo", async () => {
  const ops: OperationInfo[] = [];

  const server = createServer({}, () => new Api());
  server.on("operation", async (_ctx, info, execute) => {
    ops.push(info);
    return execute();
  });
  const client = createClient<typeof server>({}, () => mockConnect(server, {}));

  // await triggers edge + data; check the edge op specifically
  await client.root.posts;
  const edgeOp = ops.find((o) => o.op === "edge");
  expect(edgeOp).toBeDefined();
  expect(edgeOp!.name).toBe("posts");
  expect(edgeOp!.path).toBe("root.posts");
  expect(edgeOp!.args).toEqual([]);
});

test("operation event wraps get ops (method calls) with correct info", async () => {
  const ops: OperationInfo[] = [];

  const server = createServer({}, () => new Api());
  server.on("operation", async (_ctx, info, execute) => {
    ops.push(info);
    return execute();
  });
  const client = createClient<typeof server>({}, () => mockConnect(server, {}));

  const result = await client.root.ping();
  expect(result).toBe("pong");

  // Find the get op (there may be edge ops too for root navigation)
  const getOp = ops.find((o) => o.op === "get");
  expect(getOp).toBeDefined();
  expect(getOp!.name).toBe("ping");
  expect(getOp!.path).toBe("root");
  expect(getOp!.args).toEqual([]);
});

test("operation event wraps data ops with correct info", async () => {
  const ops: OperationInfo[] = [];

  const server = createServer({}, () => new Api());
  server.on("operation", async (_ctx, info, execute) => {
    ops.push(info);
    return execute();
  });
  const client = createClient<typeof server>({}, () => mockConnect(server, {}));

  const data = await client.root;
  expect(data.value).toBe("hello");

  const dataOp = ops.find((o) => o.op === "data");
  expect(dataOp).toBeDefined();
  expect(dataOp!.name).toBe("data");
  expect(dataOp!.path).toBe("root");
  expect(dataOp!.args).toEqual([]);
});

test("operation event path reflects full graph traversal", async () => {
  const ops: OperationInfo[] = [];

  const server = createServer({}, () => new Api());
  server.on("operation", async (_ctx, info, execute) => {
    ops.push(info);
    return execute();
  });
  const client = createClient<typeof server>({}, () => mockConnect(server, {}));

  const post = await client.root.posts.get("42");
  expect(post.title).toBe("Post 42");

  // Expect: edge "posts", edge "get(42)", data
  const edgeOps = ops.filter((o) => o.op === "edge");
  expect(edgeOps.length).toBe(2);
  expect(edgeOps[0]!.path).toBe("root.posts");
  expect(edgeOps[1]!.path).toBe('root.posts.get("42")');
  expect(edgeOps[1]!.args).toEqual(["42"]);

  const dataOp = ops.find((o) => o.op === "data");
  expect(dataOp).toBeDefined();
  expect(dataOp!.path).toBe('root.posts.get("42")');
});

test("operation handler sees errors before redaction", async () => {
  class FailApi extends Node {
    @method
    async boom(): Promise<string> {
      throw new Error("secret internal error");
    }
  }

  const results: OperationResult[] = [];

  const server = createServer({ redactErrors: true }, () => new FailApi());
  server.on("operation", async (_ctx, _info, execute) => {
    const result = await execute();
    results.push(result);
    return result;
  });
  const client = createClient<typeof server>({}, () => mockConnect(server, {}));

  try {
    await client.root.boom();
  } catch {
    // expected
  }

  const getResult = results.find((r) => r.error !== undefined);
  expect(getResult).toBeDefined();
  // The handler sees the original error, not the redacted message
  expect(String(getResult!.error)).toContain("secret internal error");
});

test("getContext() works inside operation handler", async () => {
  let hookCtx: unknown;

  const [st, ct] = createMockTransportPair();
  const server = createServer({}, () => new Api());
  server.on("operation", async (_ctx, _info, execute) => {
    hookCtx = getContext();
    return execute();
  });
  server.handle(st, { role: "admin" });
  const client = createClient<typeof server>({}, () => ct);

  await client.root.ping();
  expect(hookCtx).toEqual({ role: "admin" });
});

test("multiple operations produce separate handler calls", async () => {
  const ops: OperationInfo[] = [];

  const server = createServer({}, () => new Api());
  server.on("operation", async (_ctx, info, execute) => {
    ops.push(info);
    return execute();
  });
  const client = createClient<typeof server>({}, () => mockConnect(server, {}));

  await client.root.posts.get("1");
  await client.root.posts.get("2");

  // Each get("1") and get("2") should be separate ops
  const edgeGetOps = ops.filter((o) => o.op === "edge" && o.name === "get");
  expect(edgeGetOps.length).toBe(2);
  expect(edgeGetOps[0]!.path).toBe('root.posts.get("1")');
  expect(edgeGetOps[1]!.path).toBe('root.posts.get("2")');
});

test("operation handler receives signal", async () => {
  let receivedSignal: AbortSignal | undefined;

  const server = createServer({}, () => new Api());
  server.on("operation", async (_ctx, info, execute) => {
    receivedSignal = info.signal;
    return execute();
  });
  const client = createClient<typeof server>({}, () => mockConnect(server, {}));

  await client.root.ping();
  expect(receivedSignal).toBeInstanceOf(AbortSignal);
  expect(receivedSignal!.aborted).toBe(false);
});

test("operation handler receives messageId", async () => {
  const messageIds: number[] = [];

  const server = createServer({}, () => new Api());
  server.on("operation", async (_ctx, info, execute) => {
    messageIds.push(info.messageId);
    return execute();
  });
  const client = createClient<typeof server>({}, () => mockConnect(server, {}));

  await client.root.ping();
  await client.root.ping();

  expect(messageIds.length).toBeGreaterThanOrEqual(2);
  // Message IDs should be unique
  expect(new Set(messageIds).size).toBe(messageIds.length);
});

// -- Middleware composition --

test("multiple operation handlers compose as middleware in registration order", async () => {
  const order: string[] = [];

  const server = createServer({}, () => new Api());
  server.on("operation", async (_ctx, _info, execute) => {
    order.push("A:before");
    const result = await execute();
    order.push("A:after");
    return result;
  });
  server.on("operation", async (_ctx, _info, execute) => {
    order.push("B:before");
    const result = await execute();
    order.push("B:after");
    return result;
  });
  const client = createClient<typeof server>({}, () => mockConnect(server, {}));

  await client.root.ping();

  // Find the sequence for one operation (get op for ping)
  // A is outermost, B is innermost
  expect(order).toEqual(
    expect.arrayContaining(["A:before", "B:before", "B:after", "A:after"]),
  );
  // Verify ordering: A:before comes before B:before, B:after comes before A:after
  const aBeforeIdx = order.indexOf("A:before");
  const bBeforeIdx = order.indexOf("B:before");
  const bAfterIdx = order.indexOf("B:after");
  const aAfterIdx = order.indexOf("A:after");
  expect(aBeforeIdx).toBeLessThan(bBeforeIdx);
  expect(bBeforeIdx).toBeLessThan(bAfterIdx);
  expect(bAfterIdx).toBeLessThan(aAfterIdx);
});

test("off('operation') removes handler from future operations", async () => {
  const calls: string[] = [];

  const server = createServer({}, () => new Api());
  const handler = async (
    _ctx: unknown,
    _info: unknown,
    execute: () => Promise<OperationResult>,
  ) => {
    calls.push("handler");
    return execute();
  };
  server.on("operation", handler);
  const client = createClient<typeof server>({}, () => mockConnect(server, {}));

  await client.root.ping();
  const callsAfterFirst = calls.length;
  expect(callsAfterFirst).toBeGreaterThan(0);

  server.off("operation", handler);

  await client.root.ping();
  // No new calls after off()
  expect(calls.length).toBe(callsAfterFirst);
});

// -- getContext / abortThisConn / abortSignal --

test("context functions throw outside of a request", () => {
  expect(() => getContext()).toThrow(
    "getContext() called outside of a request",
  );
  expect(() => abortSignal()).toThrow(
    "abortSignal() called outside of a request",
  );
  expect(() => abortThisConn()).toThrow(
    "abortThisConn() called outside of a request",
  );
});

test("getContext() returns the connection context inside an edge getter", async () => {
  let captured: unknown = null;

  class Child extends Node {
    value = "ok";
  }

  class CtxRoot extends Node {
    @edge(Child)
    get child(): Child {
      captured = getContext();
      return new Child();
    }
  }

  const [serverTransport, clientTransport] = createMockTransportPair();
  const gpc = createServer({}, () => new CtxRoot());
  gpc.handle(serverTransport, { role: "admin" });
  const client = createClient<typeof gpc>({}, () => clientTransport);

  await client.root.child;
  expect(captured).toEqual({ role: "admin" });
});

test("getContext() returns different context per connection", async () => {
  const captured: unknown[] = [];

  class CtxRoot extends Node {
    @method
    async capture(): Promise<void> {
      captured.push(getContext());
    }
  }

  const [s1, c1] = createMockTransportPair();
  const [s2, c2] = createMockTransportPair();
  const gpc = createServer({}, () => new CtxRoot());
  gpc.handle(s1, { id: 1 });
  gpc.handle(s2, { id: 2 });

  const client1 = createClient<typeof gpc>({}, () => c1);
  const client2 = createClient<typeof gpc>({}, () => c2);

  await client1.root.capture();
  await client2.root.capture();

  expect(captured).toEqual([{ id: 1 }, { id: 2 }]);
});

test("getContext() works in deeply nested edge traversals", async () => {
  class CtxLeaf extends Node {
    @method
    async check(): Promise<string> {
      return (getContext() as { deep: string }).deep;
    }
  }

  class CtxMid extends Node {
    @edge(CtxLeaf)
    get leaf(): CtxLeaf {
      return new CtxLeaf();
    }
  }

  class CtxRoot extends Node {
    @edge(CtxMid)
    get mid(): CtxMid {
      return new CtxMid();
    }
  }

  const [serverTransport, clientTransport] = createMockTransportPair();
  const gpc = createServer({}, () => new CtxRoot());
  gpc.handle(serverTransport, { deep: "yes" });
  const client = createClient<typeof gpc>({}, () => clientTransport);

  const result = await client.root.mid.leaf.check();
  expect(result).toBe("yes");
});

test("getContext() survives across await boundary", async () => {
  class CtxRoot extends Node {
    @method
    async delayedWhoAmI(): Promise<string> {
      await new Promise((r) => setTimeout(r, 10));
      return (getContext() as { userId: string }).userId;
    }
  }

  const [serverTransport, clientTransport] = createMockTransportPair();
  const gpc = createServer({}, () => new CtxRoot());
  gpc.handle(serverTransport, { userId: "u_456" });
  const client = createClient<typeof gpc>({}, () => clientTransport);

  const result = await client.root.delayedWhoAmI();
  expect(result).toBe("u_456");
});

test("abortThisConn() closes the transport from a method handler", async () => {
  let transportClosed = false;

  class AbortRoot extends Node {
    @method
    async disconnect(): Promise<void> {
      abortThisConn();
    }
  }

  const [serverTransport, clientTransport] = createMockTransportPair();
  const originalClose = serverTransport.close.bind(serverTransport);
  serverTransport.close = () => {
    transportClosed = true;
    originalClose();
  };

  const gpc = createServer({}, () => new AbortRoot());
  gpc.handle(serverTransport, {});
  const client = createClient<typeof gpc>(
    { reconnect: false },
    () => clientTransport,
  );

  try {
    await client.root.disconnect();
  } catch {
    // Client may receive an error since transport closes mid-request
  }

  await flush();
  expect(transportClosed).toBe(true);
});

test("abortThisConn() with reconnect triggers reconnection", async () => {
  const events: string[] = [];
  let connectionCount = 0;

  class AbortRoot extends Node {
    @method
    async kick(): Promise<string> {
      if (connectionCount <= 1) {
        abortThisConn();
      }
      return "survived";
    }

    @method
    async ping(): Promise<string> {
      return "pong";
    }
  }

  const gpc = createServer({}, () => new AbortRoot());

  const transportFactory = () => {
    connectionCount++;
    const [serverTransport, clientTransport] = createMockTransportPair();
    gpc.handle(serverTransport, {});
    return clientTransport;
  };

  const client = createClient<typeof gpc>(
    { reconnect: { initialDelay: 10 } },
    transportFactory,
  );

  client.on("disconnect", () => events.push("disconnect"));
  client.on("reconnect", () => events.push("reconnect"));

  const result1 = await client.root.ping();
  expect(result1).toBe("pong");

  const result2 = await client.root.kick();
  expect(result2).toBe("survived");
  expect(connectionCount).toBe(2);
  expect(events).toEqual(["disconnect", "reconnect"]);
});
