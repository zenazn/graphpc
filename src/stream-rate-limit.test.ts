import { expect, test } from "bun:test";
import { stream, edge } from "./decorators";
import { createMockTransportPair } from "./protocol";
import { createServer } from "./server";
import { fakeTimers, flush, type WireMessage } from "./test-utils";
import { Node } from "./types";
import { createSerializer } from "./serialization";

const serializer = createSerializer();

// A generator that yields as fast as the consumer pulls — no artificial delay,
// so the only throttle on egress is whatever the server applies.
class Firehose extends Node {
  @stream
  async *spew(signal: AbortSignal): AsyncGenerator<number> {
    let i = 0;
    while (!signal.aborted) {
      yield i++;
    }
  }
}

class FirehoseApi extends Node {
  @edge(Firehose)
  get firehose(): Firehose {
    return new Firehose();
  }
}

function countData(received: string[]): number {
  return received.filter(
    (r) => (serializer.parse(r) as WireMessage).op === "stream_data",
  ).length;
}

async function startSpew(
  clientTransport: { send: (data: string) => void },
  received: string[],
  credits: number,
): Promise<number> {
  await flush();
  received.length = 0;
  clientTransport.send(
    serializer.stringify({ op: "edge", tok: 0, edge: "firehose" }),
  );
  await flush();
  received.length = 0;
  clientTransport.send(
    serializer.stringify({
      op: "stream_start",
      tok: 1,
      stream: "spew",
      credits,
    }),
  );
  for (let i = 0; i < 10; i++) await flush();
  const startMsg = received
    .map((r) => serializer.parse(r) as WireMessage)
    .find((m) => m.op === "stream_start")!;
  expect(startMsg).toBeDefined();
  expect(startMsg.error).toBeUndefined();
  return startMsg.sid as number;
}

test("stream egress is bounded by the token bucket despite a huge credit grant", async () => {
  const timers = fakeTimers();
  const [serverTransport, clientTransport] = createMockTransportPair();
  const received: string[] = [];
  clientTransport.addEventListener("message", (e) => received.push(e.data));

  const server = createServer(
    {
      idleTimeout: 0,
      pingInterval: 0,
      lruTTL: 0,
      maxOperationTimeout: 0,
      maxCredits: 10000,
      rateLimit: { bucketSize: 5, refillRate: 10 },
      timers,
    },
    () => new FirehoseApi(),
  );
  server.handle(serverTransport, {});

  const sid = await startSpew(clientTransport, received, 10000);

  // Without metering, all 10000 credits would unlock 10000 frames. With the
  // per-frame token charge, egress stalls at roughly the bucket size.
  const burst = countData(received);
  expect(burst).toBeGreaterThan(0);
  expect(burst).toBeLessThanOrEqual(5);

  // The pump paused on a refill timer rather than dying — the only timer that
  // can be pending here (idle/ping/lru/op timeouts all disabled) is the stream
  // resume timer.
  expect(timers.pending()).toBeGreaterThanOrEqual(1);

  clientTransport.send(serializer.stringify({ op: "stream_cancel", sid }));
  await flush();
  // Cancelling clears the resume timer (no leak).
  expect(timers.pending()).toBe(0);
});

test("a stream ends with RateLimitError (not a silent hang) when the bucket can never refill", async () => {
  const [serverTransport, clientTransport] = createMockTransportPair();
  const received: string[] = [];
  clientTransport.addEventListener("message", (e) => received.push(e.data));

  const server = createServer(
    {
      idleTimeout: 0,
      pingInterval: 0,
      lruTTL: 0,
      maxOperationTimeout: 0,
      maxCredits: 10000,
      rateLimit: { bucketSize: 10, refillRate: 0 }, // drains and never recovers
    },
    () => new FirehoseApi(),
  );
  server.handle(serverTransport, {});

  const sid = await startSpew(clientTransport, received, 10000);
  for (let i = 0; i < 5; i++) await flush();

  const messages = received.map((r) => serializer.parse(r) as WireMessage);
  // Once the bucket empties with no possible refill, the pump must terminate
  // the stream with a RateLimitError so the client settles — not park it
  // indefinitely with no stream_end.
  const endMsg = messages.find((m) => m.op === "stream_end");
  expect(endMsg).toBeDefined();
  expect((endMsg!.error as { code?: string } | undefined)?.code).toBe(
    "RATE_LIMITED",
  );
  expect(sid).toBeLessThan(0);
});

test("a stream pauses on socket backpressure and resumes once the buffer drains", async () => {
  const timers = fakeTimers();
  const [serverTransport, clientTransport] = createMockTransportPair();
  const received: string[] = [];
  clientTransport.addEventListener("message", (e) => received.push(e.data));

  // Controllable backpressure signal on the server-side transport.
  let buffered = 0;
  (
    serverTransport as unknown as { bufferedAmount?: () => number }
  ).bufferedAmount = () => buffered;

  const server = createServer(
    {
      idleTimeout: 0,
      pingInterval: 0,
      lruTTL: 0,
      maxOperationTimeout: 0,
      maxCredits: 10000,
      rateLimit: false, // isolate: socket backpressure is the only throttle
      maxBufferedBytes: 1000,
      timers,
    },
    () => new FirehoseApi(),
  );
  server.handle(serverTransport, {});

  // Over the high-water mark before the stream even starts pumping.
  buffered = 5000;
  const sid = await startSpew(clientTransport, received, 50);

  // The pump must refuse to keep filling the send buffer: at most one in-flight
  // frame, and a resume poll is pending. (Without byte-level backpressure the
  // pump would have flushed all 50 credits' worth of frames.)
  const stalled = countData(received);
  expect(stalled).toBeLessThanOrEqual(1);
  expect(timers.pending()).toBeGreaterThanOrEqual(1);

  // Drain the socket and let the poll fire — frames flow again.
  buffered = 0;
  timers.fire();
  await flush();
  expect(countData(received)).toBeGreaterThan(stalled);

  clientTransport.send(serializer.stringify({ op: "stream_cancel", sid }));
  await flush();
});

test("backpressure works with a Web WebSocket-style numeric bufferedAmount property", async () => {
  const timers = fakeTimers();
  const [serverTransport, clientTransport] = createMockTransportPair();
  const received: string[] = [];
  clientTransport.addEventListener("message", (e) => received.push(e.data));

  // Web WebSocket / ws expose bufferedAmount as a readonly number getter, not
  // a method. The server must treat that shape as a backpressure signal too —
  // not call it as a function (which would throw and tear the stream down).
  let buffered = 0;
  Object.defineProperty(serverTransport, "bufferedAmount", {
    get: () => buffered,
    configurable: true,
  });

  const server = createServer(
    {
      idleTimeout: 0,
      pingInterval: 0,
      lruTTL: 0,
      maxOperationTimeout: 0,
      maxCredits: 10000,
      rateLimit: false, // isolate: socket backpressure is the only throttle
      maxBufferedBytes: 1000,
      timers,
    },
    () => new FirehoseApi(),
  );
  server.handle(serverTransport, {});

  // Over the high-water mark before the stream even starts pumping.
  buffered = 5000;
  const sid = await startSpew(clientTransport, received, 50);

  // The stream must NOT have been torn down with an error…
  const endMsg = received
    .map((r) => serializer.parse(r) as WireMessage)
    .find((m) => m.op === "stream_end");
  expect(endMsg).toBeUndefined();
  // …it paused: at most one in-flight frame, with a resume poll pending.
  const stalled = countData(received);
  expect(stalled).toBeLessThanOrEqual(1);
  expect(timers.pending()).toBeGreaterThanOrEqual(1);

  // Drain the socket and let the poll fire — frames flow again.
  buffered = 0;
  timers.fire();
  await flush();
  expect(countData(received)).toBeGreaterThan(stalled);

  clientTransport.send(serializer.stringify({ op: "stream_cancel", sid }));
  await flush();
});

test("a throttled stream resumes and delivers more frames as the bucket refills", async () => {
  // Real timers: the rate limiter refills off Date.now(), so let real time pass.
  const [serverTransport, clientTransport] = createMockTransportPair();
  const received: string[] = [];
  clientTransport.addEventListener("message", (e) => received.push(e.data));

  const server = createServer(
    {
      idleTimeout: 0,
      pingInterval: 0,
      maxCredits: 10000,
      rateLimit: { bucketSize: 3, refillRate: 200 },
    },
    () => new FirehoseApi(),
  );
  server.handle(serverTransport, {});

  const sid = await startSpew(clientTransport, received, 10000);
  const before = countData(received);
  expect(before).toBeGreaterThan(0);

  // Let real time pass so the bucket refills and the resume timer re-pumps.
  await new Promise((r) => setTimeout(r, 60));
  await flush();
  const after = countData(received);

  // Resume delivered more frames over time...
  expect(after).toBeGreaterThan(before);
  // ...but egress is still bounded by refill, nowhere near the 10000 credits.
  expect(after).toBeLessThan(1000);

  clientTransport.send(serializer.stringify({ op: "stream_cancel", sid }));
  await flush();
});
