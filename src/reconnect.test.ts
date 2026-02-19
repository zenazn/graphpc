import { test, expect } from "bun:test";
import { z } from "zod";
import { edge, method } from "./decorators.ts";
import { createServer } from "./server.ts";
import { createClient } from "./client.ts";
import { createMockTransportPair } from "./protocol.ts";
import { createSerializer } from "./serialization.ts";
import { RpcError, ConnectionLostError } from "./errors.ts";
import { Node } from "./types.ts";
import type { Transport } from "./protocol.ts";
import { flush, waitForEvent } from "./test-utils.ts";

/** Yields to the microtask queue so deferred .then() calls can fire. */
const tick = () => Promise.resolve();

// -- Test API --

class Post extends Node {
  id: string;
  title: string;

  constructor(id: string, title: string) {
    super();
    this.id = id;
    this.title = title;
  }

  @method
  async getTitle(): Promise<string> {
    return this.title;
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
  @edge(PostsService)
  get posts(): PostsService {
    return new PostsService();
  }

  @method
  async ping(): Promise<string> {
    return "pong";
  }

  @method
  async slow(): Promise<string> {
    await new Promise((r) => setTimeout(r, 200));
    return "done";
  }
}

/**
 * Setup helper. Returns a transportFactory that creates successive mock
 * transport pairs, each wired to a fresh server.handle(). The disconnect()
 * helper closes the current server-side transport.
 */
function setup() {
  const gpc = createServer({}, () => new Api());
  let currentServerTransport: Transport | null = null;

  const transportFactory = () => {
    const [serverTransport, clientTransport] = createMockTransportPair();
    currentServerTransport = serverTransport;
    gpc.handle(serverTransport, {});
    return clientTransport;
  };

  const client = createClient<typeof gpc>(
    { reconnect: true },
    transportFactory,
  );

  const disconnect = () => {
    if (currentServerTransport) {
      currentServerTransport.close();
      currentServerTransport = null;
    }
  };

  return { client, disconnect, gpc };
}

// -- Test cases --

test("no reconnect — disconnect rejects pending with CONNECTION_CLOSED", async () => {
  const gpc = createServer({}, (_ctx: unknown) => new Api());
  let currentServerTransport: Transport | null = null;

  const transportFactory = () => {
    const [serverTransport, clientTransport] = createMockTransportPair();
    currentServerTransport = serverTransport;
    gpc.handle(serverTransport, {});
    return clientTransport;
  };

  // Explicitly disable reconnect
  const client = createClient<typeof gpc>(
    { reconnect: false },
    transportFactory,
  );

  // Force operation to start immediately (Promise.resolve triggers .then on the stub)
  const promise = Promise.resolve(client.root.slow());

  // Let the request be sent (schema arrives + message sent)
  await client.ready;
  await flush();

  // Disconnect before slow() can respond (takes 200ms)
  currentServerTransport!.close();

  try {
    await promise;
    expect.unreachable("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe("CONNECTION_CLOSED");
  }
});

test("idle disconnect — next operation opens fresh connection (lazy reconnect)", async () => {
  const { client, disconnect } = setup();

  // Complete an initial operation
  const result1 = await client.root.ping();
  expect(result1).toBe("pong");

  // Disconnect while idle (no pending operations)
  disconnect();

  // No eager reconnect — next operation lazily opens a fresh connection
  const result2 = await client.root.ping();
  expect(result2).toBe("pong");
});

test("in-flight operation replayed on new connection", async () => {
  const gpc = createServer({}, (_ctx: unknown) => new Api());
  let currentServerTransport: Transport | null = null;

  const transportFactory = () => {
    const [serverTransport, clientTransport] = createMockTransportPair();
    currentServerTransport = serverTransport;
    gpc.handle(serverTransport, {});
    return clientTransport;
  };

  const client = createClient<typeof gpc>(
    { reconnect: true },
    transportFactory,
  );

  // Start a slow operation (200ms on server)
  const promise = client.root.slow();

  // Let schema arrive and request be sent
  await client.ready;
  await flush();

  // Disconnect before response (slow takes 200ms)
  currentServerTransport!.close();

  // The promise should resolve on the new connection (slow runs again on new server)
  const result = await promise;
  expect(result).toBe("done");
});

test("deep path works after idle disconnect", async () => {
  const { client, disconnect } = setup();

  await client.ready;

  // Disconnect while idle
  disconnect();

  // Deep path lazily connects and completes on fresh connection
  const result = await client.root.posts.count();
  expect(result).toBe(42);
});

test("edge deduplication — shared prefixes sent once on replay", async () => {
  const gpc = createServer({}, (_ctx: unknown) => new Api());
  let currentServerTransport: Transport | null = null;
  let serverReceivedMessages: any[] = [];

  const transportFactory = () => {
    const [serverTransport, clientTransport] = createMockTransportPair();
    currentServerTransport = serverTransport;

    // Capture messages the server receives from the client (use devalue serializer)
    serverReceivedMessages = [];
    const origAddEventListener =
      serverTransport.addEventListener.bind(serverTransport);
    serverTransport.addEventListener = ((type: string, listener: any) => {
      if (type === "message") {
        origAddEventListener("message", (event: { data: string }) => {
          serverReceivedMessages.push(createSerializer().parse(event.data));
          listener(event);
        });
      } else {
        origAddEventListener(type as any, listener);
      }
    }) as typeof serverTransport.addEventListener;

    gpc.handle(serverTransport, {});
    return clientTransport;
  };

  const client = createClient<typeof gpc>(
    { reconnect: true },
    transportFactory,
  );

  // Complete two operations sharing the "posts" edge prefix
  await client.root.posts.count();
  await client.root.posts.get("1");

  // On first connection, "posts" edge should be sent only once
  const firstConnPostsEdges = serverReceivedMessages.filter(
    (m: any) => m.op === "edge" && m.edge === "posts",
  );
  expect(firstConnPostsEdges.length).toBe(1);

  // Disconnect while idle — resolvedEdges is cleared
  currentServerTransport!.close();

  // New concurrent operations on second connection (lazy reconnect)
  const [count] = await Promise.all([
    client.root.posts.count(),
    client.root.posts.get("1"),
  ]);

  expect(count).toBe(42);

  // On second connection, "posts" edge should also be sent once (deduplication)
  const secondConnPostsEdges = serverReceivedMessages.filter(
    (m: any) => m.op === "edge" && m.edge === "posts",
  );
  expect(secondConnPostsEdges.length).toBe(1);
});

test("max retries exhausted — onReconnectFailed fires, pending rejected with ConnectionLostError", async () => {
  let failedCalled = false;

  const gpc = createServer({}, (_ctx: unknown) => new Api());
  let currentServerTransport: Transport | null = null;
  let factoryCallCount = 0;

  const transportFactory = (): Transport => {
    factoryCallCount++;
    if (factoryCallCount <= 1) {
      const [serverTransport, clientTransport] = createMockTransportPair();
      currentServerTransport = serverTransport;
      gpc.handle(serverTransport, {});
      return clientTransport;
    }
    throw new Error("connection refused");
  };

  const client = createClient<typeof gpc>(
    {
      reconnect: {
        maxRetries: 2,
        initialDelay: 10,
        multiplier: 1,
      },
    },
    transportFactory,
  );

  client.on("reconnectFailed", () => {
    failedCalled = true;
  });

  // Let initial connection establish
  await client.root.ping();

  const promise = Promise.resolve(client.root.posts.count());
  await tick();
  currentServerTransport!.close();

  try {
    await promise;
    expect.unreachable("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(ConnectionLostError);
    expect(err.code).toBe("CONNECTION_LOST");
  }

  expect(failedCalled).toBe(true);
});

test("idle disconnect fires 'disconnect' but not 'reconnect'", async () => {
  const events: string[] = [];
  const gpc = createServer({}, (_ctx: unknown) => new Api());
  let currentServerTransport: Transport | null = null;

  const transportFactory = () => {
    const [serverTransport, clientTransport] = createMockTransportPair();
    currentServerTransport = serverTransport;
    gpc.handle(serverTransport, {});
    return clientTransport;
  };

  const client = createClient<typeof gpc>(
    { reconnect: { initialDelay: 10 } },
    transportFactory,
  );

  client.on("disconnect", () => events.push("disconnect"));
  client.on("reconnect", () => events.push("reconnect"));

  await client.root.ping();

  // Idle disconnect — no eager reconnect
  currentServerTransport!.close();

  // Next operation opens a fresh connection (not a "reconnection")
  await client.root.ping();

  expect(events).toEqual(["disconnect"]);
});

test("in-flight disconnect fires 'disconnect' then 'reconnect'", async () => {
  const events: string[] = [];
  const gpc = createServer({}, (_ctx: unknown) => new Api());
  let currentServerTransport: Transport | null = null;

  const transportFactory = () => {
    const [serverTransport, clientTransport] = createMockTransportPair();
    currentServerTransport = serverTransport;
    gpc.handle(serverTransport, {});
    return clientTransport;
  };

  const client = createClient<typeof gpc>(
    { reconnect: { initialDelay: 10 } },
    transportFactory,
  );

  client.on("disconnect", () => events.push("disconnect"));
  client.on("reconnect", () => events.push("reconnect"));

  // Start slow operation (200ms server-side)
  const promise = Promise.resolve(client.root.slow());
  await client.ready;
  await flush();

  // Disconnect while slow is in-flight (response delayed 200ms)
  currentServerTransport!.close();

  // Promise completes on reconnected transport
  await promise;

  expect(events).toEqual(["disconnect", "reconnect"]);
});

test("off removes event listener", async () => {
  const events: string[] = [];
  const gpc = createServer({}, (_ctx: unknown) => new Api());
  let currentServerTransport: Transport | null = null;

  const transportFactory = () => {
    const [serverTransport, clientTransport] = createMockTransportPair();
    currentServerTransport = serverTransport;
    gpc.handle(serverTransport, {});
    return clientTransport;
  };

  const client = createClient<typeof gpc>(
    { reconnect: { initialDelay: 10 } },
    transportFactory,
  );

  const handler = () => events.push("disconnect");
  client.on("disconnect", handler);
  client.off("disconnect", handler);

  await client.root.ping();

  currentServerTransport!.close();

  // Next operation opens fresh connection
  await client.root.ping();

  // Handler was removed — no events recorded
  expect(events).toEqual([]);
});

test("edge replay failure — caller gets edge error", async () => {
  let connectionNumber = 0;

  class FailApi extends Node {
    @edge(PostsService)
    get posts(): PostsService {
      if (connectionNumber > 1) {
        throw new Error("edge failed on reconnect");
      }
      return new PostsService();
    }

    @method
    async ping(): Promise<string> {
      return "pong";
    }
  }

  let currentServerTransport: Transport | null = null;
  const gpc = createServer({}, (_ctx: unknown) => new FailApi());

  const transportFactory = () => {
    connectionNumber++;
    const [serverTransport, clientTransport] = createMockTransportPair();
    currentServerTransport = serverTransport;
    gpc.handle(serverTransport, {});
    return clientTransport;
  };

  const client = createClient<typeof gpc>(
    { reconnect: { initialDelay: 10, maxRetries: 2 } },
    transportFactory,
  );

  // Start operation that traverses "posts" edge
  const promise = client.root.posts.count();

  // Let it start
  await client.ready;
  await flush();

  // Disconnect — edge will fail on reconnect
  currentServerTransport!.close();

  try {
    await promise;
    expect.unreachable("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(RpcError);
  }
});

test("disconnect during reconnect — retries continue", async () => {
  const gpc = createServer({}, (_ctx: unknown) => new Api());
  let connectionNumber = 0;
  let currentServerTransport: Transport | null = null;

  const transportFactory = () => {
    connectionNumber++;
    const [serverTransport, clientTransport] = createMockTransportPair();
    currentServerTransport = serverTransport;

    if (connectionNumber === 2) {
      // Second connection: close immediately after wiring (simulates flaky reconnect)
      setTimeout(() => serverTransport.close(), 5);
    }
    gpc.handle(serverTransport, {});
    return clientTransport;
  };

  const client = createClient<typeof gpc>(
    { reconnect: { initialDelay: 10, maxRetries: 5 } },
    transportFactory,
  );

  const result1 = await client.root.ping();
  expect(result1).toBe("pong");

  // Idle disconnect (connection 1)
  currentServerTransport!.close();

  // slow() lazily connects (connection 2, auto-dies after 5ms).
  // Server-side slow takes 200ms, so connection 2 dies while in-flight
  // → eager reconnect → connection 3 succeeds
  const result2 = await client.root.slow();
  expect(result2).toBe("done");
  expect(connectionNumber).toBeGreaterThanOrEqual(3);
});

test("new operations during reconnect — queued, execute after reconnect", async () => {
  const gpc = createServer({}, (_ctx: unknown) => new Api());
  let currentServerTransport: Transport | null = null;

  const transportFactory = () => {
    const [serverTransport, clientTransport] = createMockTransportPair();
    currentServerTransport = serverTransport;
    gpc.handle(serverTransport, {});
    return clientTransport;
  };

  const client = createClient<typeof gpc>(
    { reconnect: { initialDelay: 30 } },
    transportFactory,
  );

  const slowPromise = Promise.resolve(client.root.slow());
  await client.ready;
  await flush();

  // Disconnect with slow in-flight → eager reconnect (30ms delay)
  currentServerTransport!.close();

  // Start a new operation during the reconnect window
  const countPromise = client.root.posts.count();

  // Both should complete after reconnect
  const [slowResult, countResult] = await Promise.all([
    slowPromise,
    countPromise,
  ]);
  expect(slowResult).toBe("done");
  expect(countResult).toBe(42);
});

// -- reconnect() tests --

test("reconnect() after exhaustion revives client", async () => {
  const gpc = createServer({}, () => new Api());
  let currentServerTransport: Transport | null = null;
  let failFactory = false;

  const transportFactory = (): Transport => {
    if (failFactory) {
      throw new Error("connection refused");
    }
    const [serverTransport, clientTransport] = createMockTransportPair();
    currentServerTransport = serverTransport;
    gpc.handle(serverTransport, {});
    return clientTransport;
  };

  const client = createClient<typeof gpc>(
    { reconnect: { maxRetries: 2, initialDelay: 10, multiplier: 1 } },
    transportFactory,
  );

  // Establish initial connection
  await client.root.ping();

  failFactory = true;
  const failedPromise = Promise.resolve(client.root.ping());
  await tick();
  currentServerTransport!.close();
  await waitForEvent(client, "reconnectFailed");
  try {
    await failedPromise;
  } catch {}

  // Restore factory and call reconnect()
  failFactory = false;
  client.reconnect();
  await waitForEvent(client, "reconnect");

  // New operations should work
  const result = await client.root.ping();
  expect(result).toBe("pong");
});

test("new operations after exhaustion reject immediately", async () => {
  const gpc = createServer({}, () => new Api());
  let currentServerTransport: Transport | null = null;
  let factoryCallCount = 0;

  const transportFactory = (): Transport => {
    factoryCallCount++;
    if (factoryCallCount <= 1) {
      const [serverTransport, clientTransport] = createMockTransportPair();
      currentServerTransport = serverTransport;
      gpc.handle(serverTransport, {});
      return clientTransport;
    }
    throw new Error("connection refused");
  };

  const client = createClient<typeof gpc>(
    { reconnect: { maxRetries: 2, initialDelay: 10, multiplier: 1 } },
    transportFactory,
  );

  await client.root.ping();

  const failedPromise = Promise.resolve(client.root.ping());
  await tick();
  currentServerTransport!.close();
  await waitForEvent(client, "reconnectFailed");
  try {
    await failedPromise;
  } catch {}

  // New operation should reject immediately, not hang
  try {
    await client.root.ping();
    expect.unreachable("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(ConnectionLostError);
  }
});

test("reconnect() while connected is no-op", async () => {
  const { client } = setup();

  await client.root.ping();

  // Should be a no-op — client is connected
  client.reconnect();

  // Still works normally
  const result = await client.root.ping();
  expect(result).toBe("pong");
});

test("reconnect() with reconnect disabled is no-op", async () => {
  const gpc = createServer({}, () => new Api());
  const transportFactory = () => {
    const [serverTransport, clientTransport] = createMockTransportPair();
    gpc.handle(serverTransport, {});
    return clientTransport;
  };

  const client = createClient<typeof gpc>(
    { reconnect: false },
    transportFactory,
  );

  await client.root.ping();

  // Should be a no-op — reconnect is disabled
  client.reconnect();

  const result = await client.root.ping();
  expect(result).toBe("pong");
});

test("reconnect() during active reconnection restarts", async () => {
  const gpc = createServer({}, () => new Api());
  let currentServerTransport: Transport | null = null;
  let shouldFail = false;

  const transportFactory = (): Transport => {
    if (shouldFail) {
      throw new Error("connection refused");
    }
    const [serverTransport, clientTransport] = createMockTransportPair();
    currentServerTransport = serverTransport;
    gpc.handle(serverTransport, {});
    return clientTransport;
  };

  const client = createClient<typeof gpc>(
    // Large delay so the backoff timer won't fire during the test
    { reconnect: { maxRetries: 3, initialDelay: 60_000 } },
    transportFactory,
  );

  await client.root.ping();

  shouldFail = true;
  const inFlightPromise = Promise.resolve(client.root.ping());
  await tick();
  currentServerTransport!.close();
  // Let the immediate attempt (setTimeout 0) fire and fail
  await flush();

  // Now we're waiting on a 60s backoff timer. Call reconnect() to skip it.
  shouldFail = false;
  client.reconnect();
  await waitForEvent(client, "reconnect");

  // In-flight operation completes on the new connection
  const inFlightResult = await inFlightPromise;
  expect(inFlightResult).toBe("pong");

  const result = await client.root.ping();
  expect(result).toBe("pong");
});

test("reconnect() after close is no-op", async () => {
  const { client } = setup();

  await client.root.ping();
  client.close();

  // Should be a no-op — no error
  client.reconnect();
});

test("reconnect() fires reconnect event", async () => {
  const gpc = createServer({}, () => new Api());
  let currentServerTransport: Transport | null = null;
  let failFactory = false;

  const transportFactory = (): Transport => {
    if (failFactory) throw new Error("connection refused");
    const [serverTransport, clientTransport] = createMockTransportPair();
    currentServerTransport = serverTransport;
    gpc.handle(serverTransport, {});
    return clientTransport;
  };

  const client = createClient<typeof gpc>(
    { reconnect: { maxRetries: 2, initialDelay: 10, multiplier: 1 } },
    transportFactory,
  );

  const events: string[] = [];
  client.on("disconnect", () => events.push("disconnect"));
  client.on("reconnect", () => events.push("reconnect"));
  client.on("reconnectFailed", () => events.push("reconnectFailed"));

  await client.root.ping();

  failFactory = true;
  const failedPromise = Promise.resolve(client.root.ping());
  await tick();
  currentServerTransport!.close();
  await waitForEvent(client, "reconnectFailed");
  try {
    await failedPromise;
  } catch {}

  // Events so far: disconnect, reconnectFailed
  expect(events).toEqual(["disconnect", "reconnectFailed"]);

  failFactory = false;
  client.reconnect();
  await waitForEvent(client, "reconnect");

  expect(events).toEqual(["disconnect", "reconnectFailed", "reconnect"]);
});

test("reconnect() can exhaust again", async () => {
  const gpc = createServer({}, () => new Api());
  let currentServerTransport: Transport | null = null;
  let failFactory = false;

  const transportFactory = (): Transport => {
    if (failFactory) throw new Error("connection refused");
    const [serverTransport, clientTransport] = createMockTransportPair();
    currentServerTransport = serverTransport;
    gpc.handle(serverTransport, {});
    return clientTransport;
  };

  const client = createClient<typeof gpc>(
    { reconnect: { maxRetries: 2, initialDelay: 10, multiplier: 1 } },
    transportFactory,
  );

  let failedCount = 0;
  client.on("reconnectFailed", () => failedCount++);

  await client.root.ping();

  failFactory = true;
  const failedPromise = Promise.resolve(client.root.ping());
  await tick();
  currentServerTransport!.close();
  await waitForEvent(client, "reconnectFailed");
  expect(failedCount).toBe(1);
  try {
    await failedPromise;
  } catch {}

  // reconnect() with still-failing factory — should exhaust again
  client.reconnect();
  await waitForEvent(client, "reconnectFailed");
  expect(failedCount).toBe(2);
});
