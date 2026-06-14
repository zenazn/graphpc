import { expect, test } from "bun:test";
import { edge, stream } from "./decorators";
import { createMockTransportPair } from "./protocol";
import { createSerializer } from "./serialization";
import { createServer } from "./server";
import { flush, type WireMessage } from "./test-utils";
import { Node } from "./types";

const serializer = createSerializer();

// A gate the test controls so it can deliver stream_cancel while the server
// pump is parked inside `await stream.iterator.next()`.
let gate: { promise: Promise<void>; resolve: () => void };
function newGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  gate = { promise, resolve };
}

class RaceCounter extends Node {
  // Yields a value AFTER the gate — exercises the data-after-cancel race.
  @stream
  async *valueAfterGate(_signal: AbortSignal): AsyncGenerator<number> {
    yield 1;
    await gate.promise;
    yield 2;
  }

  // Completes (done) AFTER the gate — exercises the double-cleanup race.
  @stream
  async *doneAfterGate(_signal: AbortSignal): AsyncGenerator<number> {
    yield 1;
    await gate.promise;
  }

  @stream
  async *ticker(signal: AbortSignal): AsyncGenerator<number> {
    let i = 0;
    while (!signal.aborted) {
      yield i++;
      await new Promise((r) => setTimeout(r, 0));
    }
  }
}

class RaceApi extends Node {
  @edge(RaceCounter)
  get counter(): RaceCounter {
    return new RaceCounter();
  }
}

function setup(maxStreams = 32) {
  const [serverTransport, clientTransport] = createMockTransportPair();
  const received: string[] = [];
  clientTransport.addEventListener("message", (e) => received.push(e.data));
  const server = createServer(
    { maxStreams, idleTimeout: 0, pingInterval: 0, rateLimit: false },
    () => new RaceApi(),
  );
  server.handle(serverTransport, {});
  return { clientTransport, received };
}

async function navigate(clientTransport: { send: (d: string) => void }) {
  await flush();
  clientTransport.send(
    serializer.stringify({ op: "edge", tok: 0, edge: "counter" }),
  );
  await flush();
}

function dataCount(received: string[]): number {
  return received.filter(
    (r) => (serializer.parse(r) as WireMessage).op === "stream_data",
  ).length;
}

async function startStream(
  clientTransport: { send: (d: string) => void },
  received: string[],
  name: string,
): Promise<number | undefined> {
  received.length = 0;
  clientTransport.send(
    serializer.stringify({
      op: "stream_start",
      tok: 1,
      stream: name,
      credits: 8,
    }),
  );
  await flush();
  const startMsg = received
    .map((r) => serializer.parse(r) as WireMessage)
    .find((m) => m.op === "stream_start");
  return startMsg?.error ? undefined : (startMsg?.sid as number);
}

test("no stream_data is sent after stream_cancel races a pending next()", async () => {
  const { clientTransport, received } = setup();
  await navigate(clientTransport);
  newGate();

  const sid = await startStream(clientTransport, received, "valueAfterGate");
  expect(sid).toBeDefined();
  // First value flowed; pump is now parked on the gate inside next().
  expect(dataCount(received)).toBe(1);

  // Cancel while parked, then release the gate so next() resolves with value 2.
  clientTransport.send(serializer.stringify({ op: "stream_cancel", sid }));
  await flush();
  gate.resolve();
  await flush();
  await flush();

  // The post-cancel value must NOT be sent.
  expect(dataCount(received)).toBe(1);
});

test("stream_cancel racing completion does not underflow the stream count", async () => {
  // maxStreams: 1 — an underflow would let two concurrent streams open.
  const { clientTransport, received } = setup(1);
  await navigate(clientTransport);
  newGate();

  const sid = await startStream(clientTransport, received, "doneAfterGate");
  expect(sid).toBeDefined();

  // Cancel while parked, then let the generator complete (done) after the gate.
  clientTransport.send(serializer.stringify({ op: "stream_cancel", sid }));
  await flush();
  gate.resolve();
  await flush();
  await flush();

  // The slot must be back to exactly free (count 0): one ticker opens...
  const sid1 = await startStream(clientTransport, received, "ticker");
  expect(sid1).toBeDefined();

  // ...and a second concurrent ticker must be rejected by maxStreams: 1.
  received.length = 0;
  clientTransport.send(
    serializer.stringify({
      op: "stream_start",
      tok: 1,
      stream: "ticker",
      credits: 8,
    }),
  );
  await flush();
  const second = received
    .map((r) => serializer.parse(r) as WireMessage)
    .find((m) => m.op === "stream_start");
  expect(second).toBeDefined();
  expect((second!.error as { code?: string })?.code).toBe(
    "STREAM_LIMIT_EXCEEDED",
  );

  clientTransport.send(
    serializer.stringify({ op: "stream_cancel", sid: sid1 }),
  );
  await flush();
});
