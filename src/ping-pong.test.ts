import { expect, test } from "bun:test";
import { createMockTransportPair } from "./protocol";
import { createSerializer } from "./serialization";
import { createServer } from "./server";
import { fakeTimers, flush } from "./test-utils";
import { Node } from "./types";

const serializer = createSerializer();

class Api extends Node {
  greeting = "hello";
}

test("server sends ping after interval, client responds with pong", async () => {
  const timers = fakeTimers();
  const server = createServer(
    { pingInterval: 5000, pingTimeout: 2000, timers },
    () => new Api(),
  );
  const [st, ct] = createMockTransportPair();

  const received: unknown[] = [];
  ct.addEventListener("message", (e) => {
    received.push(serializer.parse(e.data));
  });

  server.handle(st, {});
  await flush();

  // First message is hello
  expect(received[0]).toMatchObject({ op: "hello" });
  received.length = 0;

  // Fire the ping timer
  expect(timers.pending()).toBeGreaterThanOrEqual(1);
  timers.fire(); // fires the lowest-delay timer (ping interval)
  await flush();

  // Server should have sent a ping
  expect(received).toEqual([{ op: "ping" }]);
  received.length = 0;

  // Client sends pong
  ct.send(serializer.stringify({ op: "pong" }));
  await flush();

  // Pong timer should be cleared, ping timer re-started
  // No connection close
  expect(timers.pending()).toBeGreaterThanOrEqual(1);
});

test("missed pong closes connection", async () => {
  const timers = fakeTimers();
  const server = createServer(
    { pingInterval: 5000, pingTimeout: 2000, idleTimeout: 0, timers },
    () => new Api(),
  );
  const [st, ct] = createMockTransportPair();

  let closed = false;
  ct.addEventListener("close", () => {
    closed = true;
  });

  server.handle(st, {});
  await flush();

  // Fire the ping timer → server sends ping + starts pong timeout
  timers.fire();
  await flush();

  expect(closed).toBe(false);

  // Don't send pong — fire the pong timeout
  timers.fire();
  await flush();

  expect(closed).toBe(true);
});

test("ping does NOT reset idle timer", async () => {
  const timers = fakeTimers();
  const server = createServer(
    {
      pingInterval: 3000,
      pingTimeout: 1000,
      idleTimeout: 5000,
      lruTTL: 0,
      timers,
    },
    () => new Api(),
  );
  const [st, ct] = createMockTransportPair();

  let closed = false;
  ct.addEventListener("close", () => {
    closed = true;
  });

  server.handle(st, {});
  await flush();

  // We have 2 pending timers: idle (5s) and ping (3s)
  expect(timers.pending()).toBe(2);

  // Fire ping timer (3s, smallest delay)
  timers.fire();
  await flush();

  // Now: pong timeout (1s) + idle timer (5s) still pending
  // Respond with pong
  ct.send(serializer.stringify({ op: "pong" }));
  await flush();

  // Pong timer cleared, new ping timer started.
  // Idle timer is still the original one — NOT reset by pong.
  // Fire all remaining timers — idle timer should close the connection
  timers.fireAll();
  await flush();

  expect(closed).toBe(true);
});

test("app messages reset ping timer", async () => {
  const timers = fakeTimers();
  const server = createServer(
    {
      pingInterval: 5000,
      pingTimeout: 2000,
      idleTimeout: 0,
      lruTTL: 0,
      timers,
    },
    () => new Api(),
  );
  const [st, ct] = createMockTransportPair();
  server.handle(st, {});
  await flush();

  // 1 timer pending: ping (no idle since idleTimeout=0, no LRU since lruTTL=0)
  expect(timers.pending()).toBe(1);
  const firstDelay = timers.getDelay();

  // Send an app message — this should reset the ping timer
  ct.send(serializer.stringify({ op: "data", tok: 0 }));
  await flush();

  // Ping timer was reset — still 1 pending, with a fresh interval
  // The delay should be the ping interval again (timer was recreated)
  expect(timers.pending()).toBe(1);
  expect(timers.getDelay()).toBe(firstDelay);
});

test("ping disabled when pingInterval is 0", async () => {
  const timers = fakeTimers();
  const server = createServer(
    { pingInterval: 0, idleTimeout: 0, lruTTL: 0, timers },
    () => new Api(),
  );
  const [st] = createMockTransportPair();
  server.handle(st, {});
  await flush();

  // No timers should be pending (both idle and ping disabled)
  expect(timers.pending()).toBe(0);
});
