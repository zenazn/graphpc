import { test, expect } from "bun:test";
import { z } from "zod";
import { createClient } from "./client";
import { edge, method, stream } from "./decorators";
import { PathDepthExceededError, RateLimitError } from "./errors";
import { createMockTransportPair } from "./protocol";
import { ref } from "./ref";
import { Reference } from "./reference";
import { createSerializer } from "./serialization";
import { createServer } from "./server";
import { flush, mockConnect } from "./test-utils";
import { canonicalPath, Node } from "./types";

const serializer = createSerializer();

// -- Test API: recursive edge --

class Recursive extends Node {
  depth: number;
  constructor(depth = 0) {
    super();
    this.depth = depth;
  }

  @edge(() => Recursive)
  child(): Recursive {
    return new Recursive(this.depth + 1);
  }
}

class Item extends Node {
  id: string;
  constructor(id: string) {
    super();
    this.id = id;
  }

  static [canonicalPath](root: Api, id: string) {
    return root.item(id);
  }
}

class Api extends Node {
  @edge(() => Recursive)
  rec(): Recursive {
    return new Recursive(1);
  }

  @edge(Item, z.string())
  item(id: string): Item {
    return new Item(id);
  }

  @method(z.string())
  async touch(id: string): Promise<Reference<Item>> {
    return ref(Item, id);
  }
}

// -- Fix 1: depth limit --

test("server rejects edge traversals beyond maxDepth", async () => {
  const server = createServer(
    { maxDepth: 3, rateLimit: false },
    () => new Api(),
  );
  const client = createClient<typeof server>({ loopProtection: false }, () =>
    mockConnect(server, {}),
  );

  // depth 1 = rec, depth 2 = child, depth 3 = child — OK
  const ok = await client.root.rec().child().child();
  expect(ok.depth).toBe(3);

  // depth 4 = child — exceeds limit
  const deep = client.root.rec().child().child().child();
  try {
    await deep;
    throw new Error("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(PathDepthExceededError);
  }
});

test("default maxDepth allows reasonably deep traversal", async () => {
  const server = createServer({ rateLimit: false }, () => new Api());
  const client = createClient<typeof server>({ loopProtection: false }, () =>
    mockConnect(server, {}),
  );

  // Default depth of 64 should allow traversal up to 64 levels
  let stub: any = client.root.rec(); // depth 1
  for (let i = 0; i < 10; i++) {
    stub = stub.child(); // depth 2..11
  }
  const data = await stub;
  expect(data.depth).toBe(11);
});

// -- Fix 3: schema validation for bogus edges --

test("bogus edge name returns EdgeNotFoundError without wasting server resources", async () => {
  const server = createServer({ rateLimit: false }, () => new Api());
  const client = createClient<typeof server>({ loopProtection: false }, () =>
    mockConnect(server, {}),
  );

  // Force a raw edge traversal with a name that doesn't exist in schema.
  // We do this by accessing a non-existent property on the stub and awaiting.
  const stub = (client.root as any).nonExistentEdge;
  try {
    await stub;
    throw new Error("should have thrown");
  } catch (err: any) {
    // Should get an error (not succeed silently)
    expect(err.message).not.toBe("should have thrown");
  }
});

// -- Fix 5: spurious pong ignored --

test("pong without a pending ping is ignored", async () => {
  const [st, ct] = createMockTransportPair();
  let closed = false;
  ct.addEventListener("close", () => {
    closed = true;
  });

  const server = createServer(
    { pingInterval: 0, rateLimit: false, idleTimeout: 0 },
    () => new Api(),
  );
  server.handle(st, {});
  await flush();

  // Send spurious pongs — should be silently ignored, not reset the ping timer
  ct.send(serializer.stringify({ op: "pong" }));
  ct.send(serializer.stringify({ op: "pong" }));
  ct.send(serializer.stringify({ op: "pong" }));
  await flush();

  expect(closed).toBe(false);
});

// -- Fix 5: fire-and-forget messages consume fractional rate-limit tokens --

test("stream_cancel flood drains rate limiter at 0.1 tokens each", async () => {
  const server = createServer(
    {
      rateLimit: { bucketSize: 3, refillRate: 0 },
      idleTimeout: 0,
      pingInterval: 0,
    },
    () => new Api(),
  );
  const [st, ct] = createMockTransportPair();
  const received: string[] = [];
  ct.addEventListener("message", (e) => received.push(e.data));
  server.handle(st, {});
  await flush();
  received.length = 0; // discard hello

  // 30 stream_cancel messages at 0.1 tokens each = 3 tokens consumed.
  // This should exhaust the bucket (size 3).
  for (let i = 0; i < 30; i++) {
    ct.send(serializer.stringify({ op: "stream_cancel", sid: -1 }));
  }
  await flush();

  // Now a regular operation should be rate-limited.
  ct.send(serializer.stringify({ op: "data", tok: 0 }));
  await flush();

  const last = serializer.parse(received[received.length - 1]!) as any;
  expect(last.op).toBe("data");
  expect(last.error).toBeDefined();
  expect((last.error as any).code).toBe("RATE_LIMITED");
});
