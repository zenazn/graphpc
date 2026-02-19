import { test, expect } from "bun:test";
import { edge, method } from "./decorators.ts";
import { getContext, abortThisConn } from "./context.ts";
import { createServer } from "./server.ts";
import { createClient } from "./client.ts";
import { createMockTransportPair } from "./protocol.ts";
import { RpcError } from "./errors.ts";
import type { Transport } from "./protocol.ts";
import { Node } from "./types.ts";
import type { ServerInstance } from "./types.ts";
import { flush } from "./test-utils.ts";

test("getContext() throws outside of a request", () => {
  expect(() => getContext()).toThrow(
    "getContext() called outside of a request",
  );
});

test("getContext() returns the connection context inside an edge getter", async () => {
  let captured: unknown = null;

  class Child extends Node {
    value = "ok";
  }

  class Root extends Node {
    @edge(Child)
    get child(): Child {
      captured = getContext();
      return new Child();
    }
  }

  const [serverTransport, clientTransport] = createMockTransportPair();
  const gpc = createServer({}, () => new Root());
  gpc.handle(serverTransport, { role: "admin" });
  const client = createClient<typeof gpc>({}, () => clientTransport);

  await client.root.child;
  expect(captured).toEqual({ role: "admin" });
});

test("getContext() returns the connection context inside a method", async () => {
  let captured: unknown = null;

  class Root extends Node {
    @method
    async whoAmI(): Promise<string> {
      const ctx = getContext() as any;
      captured = ctx;
      return ctx.userId;
    }
  }

  const [serverTransport, clientTransport] = createMockTransportPair();
  const gpc = createServer({}, () => new Root());
  gpc.handle(serverTransport, { userId: "u_123" });
  const client = createClient<typeof gpc>({}, () => clientTransport);

  const result = await client.root.whoAmI();
  expect(result).toBe("u_123");
  expect(captured).toEqual({ userId: "u_123" });
});

test("getContext() returns different context per connection", async () => {
  const captured: unknown[] = [];

  class Root extends Node {
    @method
    async capture(): Promise<void> {
      captured.push(getContext());
    }
  }

  const [s1, c1] = createMockTransportPair();
  const [s2, c2] = createMockTransportPair();
  const gpc = createServer({}, () => new Root());
  gpc.handle(s1, { id: 1 });
  gpc.handle(s2, { id: 2 });

  const client1 = createClient<typeof gpc>({}, () => c1);
  const client2 = createClient<typeof gpc>({}, () => c2);

  await client1.root.capture();
  await client2.root.capture();

  expect(captured).toEqual([{ id: 1 }, { id: 2 }]);
});

test("getContext() works in deeply nested edge traversals", async () => {
  let captured: unknown = null;

  class Leaf extends Node {
    @method
    async check(): Promise<string> {
      const ctx = getContext() as any;
      captured = ctx;
      return ctx.deep;
    }
  }

  class Mid extends Node {
    @edge(Leaf)
    get leaf(): Leaf {
      return new Leaf();
    }
  }

  class Root extends Node {
    @edge(Mid)
    get mid(): Mid {
      return new Mid();
    }
  }

  const [serverTransport, clientTransport] = createMockTransportPair();
  const gpc = createServer({}, () => new Root());
  gpc.handle(serverTransport, { deep: "yes" });
  const client = createClient<typeof gpc>({}, () => clientTransport);

  const result = await client.root.mid.leaf.check();
  expect(result).toBe("yes");
  expect(captured).toEqual({ deep: "yes" });
});

test("getContext() survives across await boundary", async () => {
  class Root extends Node {
    @method
    async delayedWhoAmI(): Promise<string> {
      await new Promise((r) => setTimeout(r, 10));
      const ctx = getContext() as any;
      return ctx.userId;
    }
  }

  const [serverTransport, clientTransport] = createMockTransportPair();
  const gpc = createServer({}, () => new Root());
  gpc.handle(serverTransport, { userId: "u_456" });
  const client = createClient<typeof gpc>({}, () => clientTransport);

  const result = await client.root.delayedWhoAmI();
  expect(result).toBe("u_456");
});

// -- abortThisConn() tests --

test("abortThisConn() throws outside of a request", () => {
  expect(() => abortThisConn()).toThrow(
    "abortThisConn() called outside of a request",
  );
});

test("abortThisConn() closes the transport when called from a method handler", async () => {
  let transportClosed = false;

  class Root extends Node {
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

  const gpc = createServer({}, () => new Root());
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

test("abortThisConn() causes client without reconnect to receive CONNECTION_CLOSED", async () => {
  class Root extends Node {
    @method
    async kick(): Promise<void> {
      abortThisConn();
    }

    @method
    async ping(): Promise<string> {
      return "pong";
    }
  }

  const [serverTransport, clientTransport] = createMockTransportPair();
  const gpc = createServer({}, () => new Root());
  gpc.handle(serverTransport, {});

  // Client without reconnect — should get CONNECTION_CLOSED error
  const client = createClient<typeof gpc>(
    { reconnect: false },
    () => clientTransport,
  );

  // First verify connectivity
  const result = await client.root.ping();
  expect(result).toBe("pong");

  // Call the method that aborts the connection — client should get an error
  try {
    await client.root.kick();
    expect.unreachable("should have thrown");
  } catch (err: any) {
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe("CONNECTION_CLOSED");
  }
});

test("abortThisConn() with reconnect-enabled client triggers reconnection", async () => {
  const events: string[] = [];
  let connectionCount = 0;

  // Only abort on the first connection to avoid infinite replay loop
  class Root extends Node {
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

  const gpc = createServer({}, () => new Root());

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

  // Verify initial connection works
  const result1 = await client.root.ping();
  expect(result1).toBe("pong");
  expect(connectionCount).toBe(1);

  // Call abortThisConn() — on reconnect, kick() won't abort again
  // so the replayed operation succeeds on the new connection
  const result2 = await client.root.kick();
  expect(result2).toBe("survived");

  expect(connectionCount).toBe(2);
  expect(events).toEqual(["disconnect", "reconnect"]);

  // New operations should work on the reconnected transport
  const result3 = await client.root.ping();
  expect(result3).toBe("pong");
});
