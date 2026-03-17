import { expect, test } from "bun:test";
import { z } from "zod";
import { edge, stream, getStreams } from "./decorators";
import { createMockTransportPair, type Transport } from "./protocol";
import { buildSchema } from "./schema";
import { createSerializer } from "./serialization";
import { createServer } from "./server";
import { flush, type WireMessage } from "./test-utils";
import { Node } from "./types";

const serializer = createSerializer();

// -- Test API definition --

class Counter extends Node {
  @stream(z.number())
  async *count(signal: AbortSignal, limit: number): AsyncGenerator<number> {
    for (let i = 0; i < limit; i++) {
      if (signal.aborted) return;
      yield i;
    }
  }

  @stream
  async *infinite(signal: AbortSignal): AsyncGenerator<string> {
    let i = 0;
    while (!signal.aborted) {
      yield `msg-${i++}`;
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  @stream
  async *errorStream(signal: AbortSignal): AsyncGenerator<number> {
    yield 1;
    throw new Error("stream-error");
  }
}

class StreamApi extends Node {
  @edge(Counter)
  get counter(): Counter {
    return new Counter();
  }
}

function setupStream(opts: { maxStreams?: number } = {}) {
  const [serverTransport, clientTransport] = createMockTransportPair();
  const received: string[] = [];

  clientTransport.addEventListener("message", (e) => {
    received.push(e.data);
  });

  const server = createServer(
    { maxStreams: opts.maxStreams ?? 32, idleTimeout: 0 },
    () => new StreamApi(),
  );
  server.handle(serverTransport, {});

  return { serverTransport, clientTransport, received };
}

async function navigateToCounter(
  clientTransport: { send: (data: string) => void },
  received: string[],
) {
  await flush();
  // Discard hello
  received.length = 0;

  // Navigate to counter edge (tok 0 -> edge "counter")
  clientTransport.send(
    serializer.stringify({ op: "edge", tok: 0, edge: "counter" }),
  );
  await flush();
  // Discard edge response
  received.length = 0;
}

test("basic stream: yields values and completes", async () => {
  const { clientTransport, received } = setupStream();
  await navigateToCounter(clientTransport, received);

  // Start a stream: count(3)
  clientTransport.send(
    serializer.stringify({
      op: "stream_start",
      tok: 1,
      stream: "count",
      args: [3],
      credits: 8,
    }),
  );
  await flush();

  const messages = received.map((r) => serializer.parse(r) as WireMessage);

  // First message: stream_start success
  const startMsg = messages.find((m) => m.op === "stream_start")!;
  expect(startMsg).toBeDefined();
  expect(startMsg.error).toBeUndefined();
  expect(startMsg.sid).toBeLessThan(0);

  // Data messages
  const dataMessages = messages.filter((m) => m.op === "stream_data");
  expect(dataMessages.length).toBe(3);
  expect(dataMessages.map((m) => m.data)).toEqual([0, 1, 2]);

  // End message
  const endMsg = messages.find((m) => m.op === "stream_end")!;
  expect(endMsg).toBeDefined();
  expect(endMsg.error).toBeUndefined();
});

test("stream cancellation: cancel() stops the server generator", async () => {
  const { clientTransport, received } = setupStream();
  await navigateToCounter(clientTransport, received);

  // Start the infinite stream
  clientTransport.send(
    serializer.stringify({
      op: "stream_start",
      tok: 1,
      stream: "infinite",
      credits: 4,
    }),
  );
  await flush();

  const startMsg = received
    .map((r) => serializer.parse(r) as WireMessage)
    .find((m) => m.op === "stream_start")!;
  expect(startMsg).toBeDefined();
  expect(startMsg.error).toBeUndefined();
  const sid = startMsg.sid;

  // Wait for some data to arrive
  await flush();

  // Cancel the stream
  clientTransport.send(serializer.stringify({ op: "stream_cancel", sid }));
  await flush();

  // After cancel, no more data should arrive
  const countBefore = received.filter(
    (r) => (serializer.parse(r) as WireMessage).op === "stream_data",
  ).length;

  await flush();
  await flush();

  const countAfter = received.filter(
    (r) => (serializer.parse(r) as WireMessage).op === "stream_data",
  ).length;
  expect(countAfter).toBe(countBefore);
});

test("stream limit exceeded returns STREAM_LIMIT_EXCEEDED", async () => {
  const { clientTransport, received } = setupStream({ maxStreams: 1 });
  await navigateToCounter(clientTransport, received);

  // Open first stream (should succeed)
  clientTransport.send(
    serializer.stringify({
      op: "stream_start",
      tok: 1,
      stream: "infinite",
      credits: 4,
    }),
  );
  await flush();
  await flush();

  const firstStart = received
    .map((r) => serializer.parse(r) as WireMessage)
    .find((m) => m.op === "stream_start")!;
  expect(firstStart).toBeDefined();
  expect(firstStart.error).toBeUndefined();

  // Open second stream (should fail)
  clientTransport.send(
    serializer.stringify({
      op: "stream_start",
      tok: 1,
      stream: "count",
      args: [5],
      credits: 8,
    }),
  );
  await flush();

  const allStarts = received
    .map((r) => serializer.parse(r) as WireMessage)
    .filter((m) => m.op === "stream_start");
  expect(allStarts.length).toBe(2);

  const secondStart = allStarts[1]!;
  expect(secondStart.error).toBeDefined();
  expect((secondStart.error as WireMessage).code).toBe("STREAM_LIMIT_EXCEEDED");
});

test("@stream decorator stores metadata", () => {
  const streams = getStreams(Counter);
  expect(streams.size).toBe(3);

  const countMeta = streams.get("count");
  expect(countMeta).toBeDefined();
  expect(countMeta!.name).toBe("count");
  expect(countMeta!.schemas.length).toBe(1);
  expect(countMeta!.paramNames).toEqual(["limit"]);

  const infiniteMeta = streams.get("infinite");
  expect(infiniteMeta).toBeDefined();
  expect(infiniteMeta!.name).toBe("infinite");
  expect(infiniteMeta!.schemas.length).toBe(0);
  expect(infiniteMeta!.paramNames).toEqual([]);
});

test("stream names appear in schema", () => {
  const { schema } = buildSchema(StreamApi, {});
  // StreamApi at index 0 has one edge "counter" pointing to Counter at index 1
  expect(schema[0]!.edges).toHaveProperty("counter");
  // Counter at index 1 should list stream names
  const counterSchema = schema[1];
  expect(counterSchema).toBeDefined();
  expect(counterSchema!.streams).toContain("count");
  expect(counterSchema!.streams).toContain("infinite");
  expect(counterSchema!.streams).toContain("errorStream");
});

test("stream end on error: generator throw propagates to client", async () => {
  const { clientTransport, received } = setupStream();
  await navigateToCounter(clientTransport, received);

  // Start errorStream
  clientTransport.send(
    serializer.stringify({
      op: "stream_start",
      tok: 1,
      stream: "errorStream",
      credits: 8,
    }),
  );
  await flush();

  const messages = received.map((r) => serializer.parse(r) as WireMessage);

  // Should get stream_start success
  const startMsg = messages.find((m) => m.op === "stream_start")!;
  expect(startMsg).toBeDefined();
  expect(startMsg.error).toBeUndefined();

  // Should get one data message (yield 1)
  const dataMessages = messages.filter((m) => m.op === "stream_data");
  expect(dataMessages.length).toBe(1);
  expect(dataMessages[0]!.data).toBe(1);

  // Should get stream_end with error
  const endMsg = messages.find((m) => m.op === "stream_end")!;
  expect(endMsg).toBeDefined();
  expect(endMsg.error).toBeDefined();
});

test("pumpStream does not produce unhandled rejection when transport.send throws", async () => {
  const [rawServer, rawClient] = createMockTransportPair();
  const received: string[] = [];

  rawClient.addEventListener("message", (e) => {
    received.push(e.data);
  });

  // Wrap server transport so send() throws after we trigger it
  let failSend = false;
  const serverTransport: Transport = {
    send(data: string) {
      if (failSend) throw new Error("transport send failed");
      rawServer.send(data);
    },
    close() {
      rawServer.close();
    },
    addEventListener(type, listener) {
      rawServer.addEventListener(type, listener);
    },
    removeEventListener(type, listener) {
      rawServer.removeEventListener(type, listener);
    },
  };

  const server = createServer(
    { maxStreams: 32, idleTimeout: 0 },
    () => new StreamApi(),
  );
  server.handle(serverTransport, {});
  await flush();
  received.length = 0;

  // Navigate to counter
  rawClient.send(serializer.stringify({ op: "edge", tok: 0, edge: "counter" }));
  await flush();
  received.length = 0;

  // Start infinite stream
  rawClient.send(
    serializer.stringify({
      op: "stream_start",
      tok: 1,
      stream: "infinite",
      credits: 2,
    }),
  );
  await flush();

  const startMsg = received
    .map((r) => serializer.parse(r) as WireMessage)
    .find((m) => m.op === "stream_start")!;
  expect(startMsg).toBeDefined();
  const sid = startMsg.sid;

  // Now make send() throw and grant credits — pumpStream should handle it
  failSend = true;

  const unhandled: unknown[] = [];
  const handler = (_reason: unknown) => {
    unhandled.push(_reason);
  };
  process.on("unhandledRejection", handler);
  try {
    rawClient.send(
      serializer.stringify({ op: "stream_credit", sid, credits: 100 }),
    );
    await flush();
    await flush();

    expect(unhandled).toEqual([]);
  } finally {
    process.removeListener("unhandledRejection", handler);
  }
});
