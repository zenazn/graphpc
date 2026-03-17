import { expect, test } from "bun:test";
import { stream } from "./decorators";
import { createMockTransportPair } from "./protocol";
import { createSerializer } from "./serialization";
import { createServer } from "./server";
import { fakeTimers, flush } from "./test-utils";
import { Node } from "./types";

const serializer = createSerializer();

class Api extends Node {
  greeting = "hello";
}

class BusyApi extends Node {
  @stream
  async *busy(_signal: AbortSignal): AsyncGenerator<number> {
    while (true) {
      await new Promise(() => {});
      yield 0;
    }
  }
}

test("close() resolves immediately with no active connections", async () => {
  const server = createServer({}, () => new Api());
  await server.close();
  // Should resolve without hanging
});

test("close() rejects new handle() calls", async () => {
  const server = createServer({ pingInterval: 0 }, () => new Api());

  // Establish a connection first
  const [st1] = createMockTransportPair();
  server.handle(st1, {});
  await flush();

  // Start closing (don't await — we need the server to be in closing state)
  const closePromise = server.close({ gracePeriod: 10000 });

  // Try to handle a new connection
  const [st2, ct2] = createMockTransportPair();
  let newConnClosed = false;
  ct2.addEventListener("close", () => {
    newConnClosed = true;
  });

  server.handle(st2, {});
  await flush();

  // New connection should be immediately closed
  expect(newConnClosed).toBe(true);

  // Clean up: close st1 to resolve the close promise
  st1.close();
  await closePromise;
});

test("close() closes idle connections immediately after abort", async () => {
  const timers = fakeTimers();
  const server = createServer({ pingInterval: 0, timers }, () => new Api());

  const [st, ct] = createMockTransportPair();
  let closed = false;
  ct.addEventListener("close", () => {
    closed = true;
  });

  server.handle(st, {});
  await flush();

  expect(closed).toBe(false);

  // Close with a grace period — idle connections should still close immediately.
  const closePromise = server.close({ gracePeriod: 5000 });
  await flush();

  expect(closed).toBe(true);
  expect(timers.pending()).toBe(0);
  await closePromise;
});

test("close() force-closes after grace period", async () => {
  const timers = fakeTimers();
  const server = createServer(
    { pingInterval: 0, idleTimeout: 0, timers },
    () => new BusyApi(),
  );

  const [st, ct] = createMockTransportPair();
  let closed = false;
  ct.addEventListener("close", () => {
    closed = true;
  });

  server.handle(st, {});
  await flush();

  ct.send(
    serializer.stringify({
      op: "stream_start",
      tok: 0,
      stream: "busy",
      credits: 1,
    }),
  );
  await flush();

  const closePromise = server.close({ gracePeriod: 3000 });
  await flush();

  // Grace timer is pending
  expect(timers.pending()).toBeGreaterThanOrEqual(1);
  expect(closed).toBe(false);

  // Fire the grace timer — should force-close
  timers.fireAll();
  await flush();

  expect(closed).toBe(true);
  await closePromise;
});

test("close() is idempotent", async () => {
  const server = createServer({ pingInterval: 0 }, () => new Api());
  const [st] = createMockTransportPair();
  server.handle(st, {});
  await flush();

  // Both calls should resolve
  const p1 = server.close({ gracePeriod: 0 });
  const p2 = server.close({ gracePeriod: 0 });
  await flush();
  await Promise.all([p1, p2]);
});

test("close() is idempotent after completion", async () => {
  const timers = fakeTimers();
  const server = createServer({ pingInterval: 0, timers }, () => new Api());
  const [st] = createMockTransportPair();
  server.handle(st, {});
  await flush();

  // First close — resolves after grace period
  const p1 = server.close({ gracePeriod: 0 });
  timers.fireAll();
  await flush();
  await p1;

  // Second close after first has fully resolved — must not hang
  await server.close();
});

test("close() fires disconnect handler", async () => {
  const timers = fakeTimers();
  const server = createServer({ pingInterval: 0, timers }, () => new Api());

  let disconnected = false;
  server.on("disconnect", () => {
    disconnected = true;
  });

  const [st] = createMockTransportPair();
  server.handle(st, {});
  await flush();

  const closePromise = server.close({ gracePeriod: 0 });
  timers.fireAll();
  await flush();

  expect(disconnected).toBe(true);
  await closePromise;
});

test("close() with wsHandlers rejects new connections and self-finalizes", async () => {
  const timers = fakeTimers();
  const server = createServer({ pingInterval: 0, timers }, () => new Api());

  // Open one connection via wsHandlers
  const handlers = server.wsHandlers<{}>((data) => data);
  const ws1 = createMockWs({});
  handlers.open(ws1);
  await flush();

  // Start closing
  let settled = false;
  const closePromise = server.close({ gracePeriod: 10_000 }).then(() => {
    settled = true;
  });

  // Try new ws connection — should be immediately closed
  const ws2 = createMockWs({});
  handlers.open(ws2);
  expect(ws2.closeCalled).toBe(true);

  await flush();
  expect(ws1.closeCalled).toBe(true);
  expect(settled).toBe(true);
  expect(timers.pending()).toBe(0);
  await closePromise;
});

// Helper to create a mock WsLike for wsHandlers tests
function createMockWs<T>(data: T) {
  const ws = {
    data,
    messages: [] as string[],
    closeCalled: false,
    send(data: string) {
      ws.messages.push(data);
    },
    close() {
      ws.closeCalled = true;
    },
  };
  return ws;
}
