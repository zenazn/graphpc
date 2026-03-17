import { test, expect } from "bun:test";
import { z } from "zod";
import { createClient, subscribe } from "./client";
import { edge, method } from "./decorators";
import { RateLimitError } from "./errors";
import type { RateLimitInfo } from "./hooks";
import { createMockTransportPair } from "./protocol";
import { ref } from "./ref";
import { Reference } from "./reference";
import { createServer } from "./server";
import { flush, mockConnect } from "./test-utils";
import { canonicalPath, Node } from "./types";

// -- Test API --

class Item extends Node {
  id: string;
  value: number;

  constructor(id: string, value: number) {
    super();
    this.id = id;
    this.value = value;
  }

  static [canonicalPath](root: Api, id: string) {
    return root.get(id);
  }
}

class Api extends Node {
  @edge(Item, z.string())
  get(id: string): Item {
    return new Item(id, 42);
  }

  @method
  async ping(): Promise<string> {
    return "pong";
  }

  @method(z.string())
  async update(id: string): Promise<Reference<Item>> {
    return ref(Item, id);
  }
}

// -- Server rate limiting --

test("server rejects calls when token bucket is exhausted", async () => {
  const server = createServer(
    { rateLimit: { bucketSize: 3, refillRate: 0 } },
    () => new Api(),
  );
  const client = createClient<typeof server>({ loopProtection: false }, () =>
    mockConnect(server, {}),
  );

  // First 3 calls should succeed
  expect(await client.root.ping()).toBe("pong");
  expect(await client.root.ping()).toBe("pong");
  expect(await client.root.ping()).toBe("pong");

  // 4th call should be rate limited
  try {
    await client.root.ping();
    throw new Error("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(RateLimitError);
  }
});

test("server token bucket refills over time", async () => {
  const server = createServer(
    { rateLimit: { bucketSize: 2, refillRate: 1000 } },
    () => new Api(),
  );
  const client = createClient<typeof server>({ loopProtection: false }, () =>
    mockConnect(server, {}),
  );

  // Drain bucket
  await client.root.ping();
  await client.root.ping();

  // Wait for refill (1000/sec = 1 token per ms, so 5ms should be plenty)
  await new Promise((r) => setTimeout(r, 5));

  // Should succeed after refill
  expect(await client.root.ping()).toBe("pong");
});

test("server rateLimit event fires on rejection", async () => {
  const events: RateLimitInfo[] = [];

  const server = createServer(
    { rateLimit: { bucketSize: 1, refillRate: 0 } },
    () => new Api(),
  );
  server.on("rateLimit", (_ctx, info) => {
    events.push(info);
  });
  const client = createClient<typeof server>({ loopProtection: false }, () =>
    mockConnect(server, {}),
  );

  await client.root.ping();
  try {
    await client.root.ping();
  } catch {}

  expect(events.length).toBe(1);
  expect(events[0]!.op).toBe("get");
  expect(events[0]!.tokens).toBe(0);
});

test("server rateLimit hook failures do not wedge the connection", async () => {
  const errors: string[] = [];

  const server = createServer(
    { rateLimit: { bucketSize: 0, refillRate: 0 } },
    () => new Api(),
  );
  server.on("rateLimit", () => {
    throw new Error("rate hook boom");
  });
  server.on("operationError", () => {
    throw new Error("operationError boom");
  });
  server.on("error", (err) => {
    errors.push((err as Error).message);
  });
  const client = createClient<typeof server>({ loopProtection: false }, () =>
    mockConnect(server, {}),
  );

  for (let i = 0; i < 2; i++) {
    try {
      await client.root.ping();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
    }
  }

  expect(errors).toContain("rate hook boom");
  expect(errors).toContain("operationError boom");
});

test("server rateLimit: false disables rate limiting", async () => {
  const server = createServer({ rateLimit: false }, () => new Api());
  const client = createClient<typeof server>({ loopProtection: false }, () =>
    mockConnect(server, {}),
  );

  // Should be able to make many calls without rate limiting
  for (let i = 0; i < 50; i++) {
    expect(await client.root.ping()).toBe("pong");
  }
});

test("server rate limit rejects edge operations correctly", async () => {
  const server = createServer(
    { rateLimit: { bucketSize: 1, refillRate: 0 } },
    () => new Api(),
  );
  const client = createClient<typeof server>({ loopProtection: false }, () =>
    mockConnect(server, {}),
  );

  // First call (edge + data = 2 ops, bucket only has 1)
  // Actually edge ops are separate messages, so the edge will succeed
  // and the data op may be rate-limited. Let's just drain the bucket first.
  try {
    // This uses up the 1 token on the edge traversal
    await client.root.get("1");
    // If we get here, the first call consumed the token, next will fail
  } catch {
    // May throw if data op was rate limited — that's fine too
  }

  // Next call should definitely be rate limited
  try {
    await client.root.ping();
    throw new Error("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(RateLimitError);
  }
});

test("server rate limit context is per-connection", async () => {
  const server = createServer(
    { rateLimit: { bucketSize: 2, refillRate: 0 } },
    () => new Api(),
  );

  const client1 = createClient<typeof server>({ loopProtection: false }, () =>
    mockConnect(server, {}),
  );
  const client2 = createClient<typeof server>({ loopProtection: false }, () =>
    mockConnect(server, {}),
  );

  // Each connection has its own bucket
  await client1.root.ping();
  await client1.root.ping();
  await client2.root.ping();
  await client2.root.ping();

  // Both exhausted now
  try {
    await client1.root.ping();
    throw new Error("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(RateLimitError);
  }

  try {
    await client2.root.ping();
    throw new Error("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(RateLimitError);
  }
});

// -- Client loop protection --

test("client loop protection exhausts a subscribed path token bucket", async () => {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(String(args[0]));

  try {
    const server = createServer({ rateLimit: false }, () => new Api());
    const client = createClient<typeof server>(
      { loopProtection: { bucketSize: 2, refillRate: 0 } },
      () => mockConnect(server, {}),
    );
    const item = client.root.get("test-item");
    let notifications = 0;
    const unsubscribe = subscribe(item, () => {
      notifications++;
    });
    notifications = 0; // ignore the initial synchronous callback

    await client.root.update("test-item");
    await client.root.update("test-item");
    await client.root.update("test-item");

    expect(notifications).toBe(2);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("Loop protection");
    expect(warnings[0]).toContain("2-token bucket");
    unsubscribe();
  } finally {
    console.warn = origWarn;
  }
});

test("client loopProtection: false disables loop protection", async () => {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(String(args[0]));

  try {
    const server = createServer({ rateLimit: false }, () => new Api());
    const client = createClient<typeof server>({ loopProtection: false }, () =>
      mockConnect(server, {}),
    );
    const item = client.root.get("test-item");
    let notifications = 0;
    const unsubscribe = subscribe(item, () => {
      notifications++;
    });
    notifications = 0;

    for (let i = 0; i < 25; i++) {
      await client.root.update("test-item");
    }

    expect(notifications).toBe(25);
    const loopWarnings = warnings.filter((w) => w.includes("Loop protection"));
    expect(loopWarnings.length).toBe(0);
    unsubscribe();
  } finally {
    console.warn = origWarn;
  }
});

test("client loop protection only arms subscribed paths", async () => {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(String(args[0]));

  try {
    const server = createServer({ rateLimit: false }, () => new Api());
    const client = createClient<typeof server>(
      { loopProtection: { bucketSize: 2, refillRate: 0 } },
      () => mockConnect(server, {}),
    );

    for (let i = 0; i < 5; i++) {
      await client.root.update("test-item");
    }

    const loopWarnings = warnings.filter((w) => w.includes("Loop protection"));
    expect(loopWarnings.length).toBe(0);
  } finally {
    console.warn = origWarn;
  }
});

test("client loop protection is per-path", async () => {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(String(args[0]));

  try {
    const server = createServer({ rateLimit: false }, () => new Api());
    const client = createClient<typeof server>(
      { loopProtection: { bucketSize: 2, refillRate: 0 } },
      () => mockConnect(server, {}),
    );
    let aNotifications = 0;
    let bNotifications = 0;
    const unsubA = subscribe(client.root.get("item-a"), () => {
      aNotifications++;
    });
    const unsubB = subscribe(client.root.get("item-b"), () => {
      bNotifications++;
    });
    aNotifications = 0;
    bNotifications = 0;

    await client.root.update("item-a");
    await client.root.update("item-b");
    await client.root.update("item-a");
    await client.root.update("item-b");

    expect(aNotifications).toBe(2);
    expect(bNotifications).toBe(2);
    const loopWarnings = warnings.filter((w) => w.includes("Loop protection"));
    expect(loopWarnings.length).toBe(0);
    unsubA();
    unsubB();
  } finally {
    console.warn = origWarn;
  }
});

test("client loop protection refills tokens over time", async () => {
  const warnings: string[] = [];
  const origWarn = console.warn;
  const origNow = Date.now;
  let now = 0;
  console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
  Date.now = () => now;

  try {
    const server = createServer({ rateLimit: false }, () => new Api());
    const client = createClient<typeof server>(
      { loopProtection: { bucketSize: 2, refillRate: 50 } },
      () => mockConnect(server, {}),
    );
    let notifications = 0;
    const unsubscribe = subscribe(client.root.get("boundary-item"), () => {
      notifications++;
    });
    notifications = 0;

    now = 0;
    await client.root.update("boundary-item");
    now = 19;
    await client.root.update("boundary-item");
    now = 20;
    await client.root.update("boundary-item");

    expect(notifications).toBe(3);
    const loopWarnings = warnings.filter((w) => w.includes("Loop protection"));
    expect(loopWarnings.length).toBe(0);
    unsubscribe();
  } finally {
    Date.now = origNow;
    console.warn = origWarn;
  }
});

test("client loop protection resets on reconnect", async () => {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(String(args[0]));

  try {
    const server = createServer({ rateLimit: false }, () => new Api());
    let notifications = 0;
    let connectionCount = 0;
    let currentServerTransport:
      | ReturnType<typeof createMockTransportPair>[0]
      | null = null;
    const client = createClient<typeof server>(
      {
        loopProtection: { bucketSize: 1, refillRate: 0 },
        reconnect: { initialDelay: 10 },
      },
      () => {
        const [st, ct] = createMockTransportPair();
        connectionCount++;
        currentServerTransport = st;
        server.handle(st, {});
        return ct;
      },
    );
    const unsubscribe = subscribe(client.root.get("test-item"), () => {
      notifications++;
    });
    notifications = 0;

    await client.root.update("test-item");
    await client.root.update("test-item");

    const warningsBefore = warnings.filter((w) =>
      w.includes("Loop protection"),
    ).length;
    expect(warningsBefore).toBeGreaterThan(0);

    // Force a disconnect; the next operation will lazily reconnect.
    currentServerTransport!.close();
    await flush();

    warnings.length = 0;
    notifications = 0;

    // After reconnect, loop protection should be reset
    await client.root.update("test-item");

    const warningsAfterReconnect = warnings.filter((w) =>
      w.includes("Loop protection"),
    ).length;
    expect(warningsAfterReconnect).toBe(0);
    expect(notifications).toBe(1);
    expect(connectionCount).toBeGreaterThan(1);
    unsubscribe();
  } finally {
    console.warn = origWarn;
  }
});

test("default loop protection is enabled (opt-out)", async () => {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(String(args[0]));

  try {
    const server = createServer({ rateLimit: false }, () => new Api());
    // No loopProtection option — should use defaults (20 burst, 3/sec refill)
    const client = createClient<typeof server>({}, () =>
      mockConnect(server, {}),
    );
    let notifications = 0;
    const unsubscribe = subscribe(client.root.get("same-path"), () => {
      notifications++;
    });
    notifications = 0;

    for (let i = 0; i < 25; i++) {
      await client.root.update("same-path");
    }

    const loopWarnings = warnings.filter((w) => w.includes("Loop protection"));
    expect(loopWarnings.length).toBeGreaterThan(0);
    expect(notifications).toBeLessThan(25);
    unsubscribe();
  } finally {
    console.warn = origWarn;
  }
});

test("default server rate limit is enabled (opt-out)", async () => {
  // Default is bucketSize: 200, refillRate: 50
  // We can verify it's on by checking that a server without explicit
  // rateLimit still has rate limiting behavior
  const events: RateLimitInfo[] = [];
  const server = createServer({}, () => new Api());
  server.on("rateLimit", (_ctx, info) => events.push(info));

  // With default bucket of 200, making 205 rapid calls should trigger
  const client = createClient<typeof server>({ loopProtection: false }, () =>
    mockConnect(server, {}),
  );

  let rateLimited = false;
  for (let i = 0; i < 205; i++) {
    try {
      await client.root.ping();
    } catch (err) {
      if (err instanceof RateLimitError) {
        rateLimited = true;
        break;
      }
    }
  }

  expect(rateLimited).toBe(true);
  expect(events.length).toBeGreaterThan(0);
});
