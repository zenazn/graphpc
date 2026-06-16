import { test, expect } from "bun:test";
import { z } from "zod";
import { edge, stream } from "./decorators";
import { createServer } from "./server";
import { createClient } from "./client";
import { createMockTransportPair } from "./protocol";
import { RpcError, ConnectionLostError } from "./errors";
import { Node } from "./types";
import type { Transport } from "./protocol";
import { flush, waitForEvent, fakeTimers, mockConnect } from "./test-utils";

class Feed extends Node {
  @stream(z.string(), z.number().optional())
  async *updates(
    signal: AbortSignal,
    label: string,
    cursor = 0,
  ): AsyncGenerator<string> {
    while (!signal.aborted) {
      yield `${label}:${cursor++}`;
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

class Mid extends Node {
  @edge(Feed)
  get feed(): Feed {
    return new Feed();
  }
}

class Root extends Node {
  @edge(Feed)
  get feed(): Feed {
    return new Feed();
  }

  @edge(Mid)
  get mid(): Mid {
    return new Mid();
  }
}

function timeoutAfter<T>(ms: number, value: T): Promise<T> {
  return new Promise((r) => setTimeout(() => r(value), ms));
}

test("a stream opened during the reconnect window does not steal a resume rebinding", async () => {
  const gpc = createServer({ idleTimeout: 0 }, () => new Root());
  const serverSides: Transport[] = [];
  let stallNextHello = false;
  const stalledHellos: Array<() => void> = [];
  const client = createClient<typeof gpc>(
    { reconnect: { initialDelay: 1, maxRetries: 3, multiplier: 1 } },
    () => {
      const [st, ct] = createMockTransportPair();
      serverSides.push(st);
      if (stallNextHello) {
        stalledHellos.push(() => gpc.handle(st, {}));
      } else {
        gpc.handle(st, {});
      }
      return ct;
    },
  );

  let cursorA = 0;
  const handleA = client.root.feed.updates("A", cursorA);
  handleA.resume = () => client.root.feed.updates("A", cursorA);
  const iterA = handleA[Symbol.asyncIterator]();
  expect(await iterA.next()).toEqual({ value: "A:0", done: false });
  cursorA = 1;

  const pendingA = iterA.next();
  stallNextHello = true;
  serverSides[0]!.close();
  // Wait until the reconnect attempt has produced a transport whose hello we
  // are holding back — the reconnect window is now provably open.
  while (stalledHellos.length === 0) await flush();

  // Open a brand-new stream mid-window.
  const handleB = client.root.feed.updates("B", 0);
  const iterB = handleB[Symbol.asyncIterator]();
  const pendingB = iterB.next();

  stallNextHello = false;
  for (const release of stalledHellos.splice(0)) release();

  // The held next() must continue stream A; the new stream must get its own data.
  expect(
    await Promise.race([pendingA, timeoutAfter(800, "hang" as const)]),
  ).toEqual({ value: "A:1", done: false });
  expect(
    await Promise.race([pendingB, timeoutAfter(800, "hang" as const)]),
  ).toEqual({ value: "B:0", done: false });
  client.close();
});

test("concurrent resumes rebind to their own streams regardless of path depth", async () => {
  const gpc = createServer({ idleTimeout: 0 }, () => new Root());
  const serverSides: Transport[] = [];
  const client = createClient<typeof gpc>(
    { reconnect: { initialDelay: 1, maxRetries: 3, multiplier: 1 } },
    () => {
      const [st, ct] = createMockTransportPair();
      serverSides.push(st);
      gpc.handle(st, {});
      return ct;
    },
  );

  // Stream A lives at a deeper path than stream B, so on replay A's edge
  // resolution takes more microtask hops than B's.
  let cursorA = 0;
  const handleA = client.root.mid.feed.updates("deep", cursorA);
  handleA.resume = () => client.root.mid.feed.updates("deep", cursorA);
  const iterA = handleA[Symbol.asyncIterator]();
  expect(await iterA.next()).toEqual({ value: "deep:0", done: false });
  cursorA = 1;

  let cursorB = 0;
  const handleB = client.root.feed.updates("shallow", cursorB);
  handleB.resume = () => client.root.feed.updates("shallow", cursorB);
  const iterB = handleB[Symbol.asyncIterator]();
  expect(await iterB.next()).toEqual({ value: "shallow:0", done: false });
  cursorB = 1;

  const pendingA = iterA.next();
  const pendingB = iterB.next();
  serverSides[0]!.close();

  expect(
    await Promise.race([pendingA, timeoutAfter(800, "hang" as const)]),
  ).toEqual({ value: "deep:1", done: false });
  expect(
    await Promise.race([pendingB, timeoutAfter(800, "hang" as const)]),
  ).toEqual({ value: "shallow:1", done: false });
  client.close();
});

test("a stream opened during the reconnect window survives a failed attempt", async () => {
  const gpc = createServer({ idleTimeout: 0 }, () => new Root());
  const serverSides: Transport[] = [];
  const refused: Transport[] = [];
  let refuseNext = false;
  const client = createClient<typeof gpc>(
    { reconnect: { initialDelay: 1, maxRetries: 3, multiplier: 1 } },
    () => {
      const [st, ct] = createMockTransportPair();
      if (refuseNext) {
        refuseNext = false;
        refused.push(st); // never handled — hello will never arrive
      } else {
        serverSides.push(st);
        gpc.handle(st, {});
      }
      return ct;
    },
  );

  let cursorA = 0;
  const handleA = client.root.feed.updates("A", cursorA);
  handleA.resume = () => client.root.feed.updates("A", cursorA);
  const iterA = handleA[Symbol.asyncIterator]();
  expect(await iterA.next()).toEqual({ value: "A:0", done: false });
  cursorA = 1;

  const pendingA = iterA.next();
  refuseNext = true;
  serverSides[0]!.close();
  while (refused.length === 0) await flush();

  // Open a new stream while attempt #1 is still dangling.
  const handleB = client.root.feed.updates("B", 0);
  const iterB = handleB[Symbol.asyncIterator]();
  const pendingB = iterB.next();

  // Attempt #1 fails; attempt #2 succeeds.
  refused[0]!.close();

  expect(
    await Promise.race([pendingA, timeoutAfter(800, "hang" as const)]),
  ).toEqual({ value: "A:1", done: false });
  expect(
    await Promise.race([pendingB, timeoutAfter(800, "hang" as const)]),
  ).toEqual({ value: "B:0", done: false });
  client.close();
});

test("retry exhaustion rejects a held resumable next() with ConnectionLostError", async () => {
  const gpc = createServer({ idleTimeout: 0 }, () => new Root());
  const serverSides: Transport[] = [];
  let refuse = false;
  const client = createClient<typeof gpc>(
    { reconnect: { initialDelay: 1, maxRetries: 2, multiplier: 1 } },
    () => {
      if (refuse) throw new Error("connection refused");
      const [st, ct] = createMockTransportPair();
      serverSides.push(st);
      gpc.handle(st, {});
      return ct;
    },
  );

  const handle = client.root.feed.updates("A", 0);
  handle.resume = () => client.root.feed.updates("A", 0);
  const iter = handle[Symbol.asyncIterator]();
  await iter.next();
  const pending = iter.next();

  refuse = true;
  serverSides[0]!.close();
  await waitForEvent(client, "reconnectFailed");

  const result = await Promise.race([
    pending.then(
      () => "resolved",
      (e) => e,
    ),
    timeoutAfter(500, "hang" as const),
  ]);
  expect(result).toBeInstanceOf(ConnectionLostError);
  client.close();
});

test("client.ready held during reconnection rejects after retry exhaustion", async () => {
  const gpc = createServer({ idleTimeout: 0 }, () => new Root());
  const serverSides: Transport[] = [];
  let refuse = false;
  const client = createClient<typeof gpc>(
    { reconnect: { initialDelay: 1, maxRetries: 2, multiplier: 1 } },
    () => {
      if (refuse) throw new Error("connection refused");
      const [st, ct] = createMockTransportPair();
      serverSides.push(st);
      gpc.handle(st, {});
      return ct;
    },
  );

  // Hold pending work so the disconnect triggers an eager reconnect.
  const handle = client.root.feed.updates("A", 0);
  handle.resume = () => client.root.feed.updates("A", 0);
  const iter = handle[Symbol.asyncIterator]();
  await iter.next();
  void iter.next().catch(() => {});

  refuse = true;
  serverSides[0]!.close();
  await flush();
  const held = client.ready; // grabbed mid-reconnection
  await waitForEvent(client, "reconnectFailed");

  const result = await Promise.race([
    held.then(
      () => "resolved",
      (e) => e,
    ),
    timeoutAfter(500, "hang" as const),
  ]);
  expect(result).toBeInstanceOf(ConnectionLostError);
  // Fresh reads after exhaustion reject too.
  expect(
    await client.ready.then(
      () => "resolved",
      (e) => e,
    ),
  ).toBeInstanceOf(ConnectionLostError);
  client.close();
});

test("'disconnect' fires once per disconnection, not once per failed attempt", async () => {
  const gpc = createServer({ idleTimeout: 0 }, () => new Root());
  const serverSides: Transport[] = [];
  let refuseCount = 0;
  const client = createClient<typeof gpc>(
    { reconnect: { initialDelay: 1, maxRetries: 5, multiplier: 1 } },
    () => {
      const [st, ct] = createMockTransportPair();
      if (refuseCount > 0) {
        refuseCount--;
        queueMicrotask(() => st.close()); // connection refused
      } else {
        serverSides.push(st);
        gpc.handle(st, {});
      }
      return ct;
    },
  );

  let disconnects = 0;
  client.on("disconnect", () => disconnects++);

  const handle = client.root.feed.updates("A", 0);
  handle.resume = () => client.root.feed.updates("A", 0);
  const iter = handle[Symbol.asyncIterator]();
  await iter.next();
  const pending = iter.next();

  refuseCount = 2; // two failed attempts, then success
  serverSides[0]!.close();
  await waitForEvent(client, "reconnect");
  await pending;

  expect(disconnects).toBe(1);
  client.close();
});

test("resume() that does not open a stream rejects the held next()", async () => {
  const gpc = createServer({ idleTimeout: 0 }, () => new Root());
  const serverSides: Transport[] = [];
  const client = createClient<typeof gpc>(
    { reconnect: { initialDelay: 1, maxRetries: 3, multiplier: 1 } },
    () => {
      const [st, ct] = createMockTransportPair();
      serverSides.push(st);
      gpc.handle(st, {});
      return ct;
    },
  );

  const handle = client.root.feed.updates("A", 0);
  handle.resume = (() => undefined) as unknown as NonNullable<
    typeof handle.resume
  >;
  const iter = handle[Symbol.asyncIterator]();
  await iter.next();
  const pending = iter.next();

  serverSides[0]!.close();
  await waitForEvent(client, "reconnect");

  const result = await Promise.race([
    pending.then(
      () => "resolved",
      (e) => e,
    ),
    timeoutAfter(500, "hang" as const),
  ]);
  expect(result).toBeInstanceOf(RpcError);
  expect((result as RpcError).code).toBe("RESUME_FAILED");
  client.close();
});

test("resume() that throws rejects the held next() with that error", async () => {
  const gpc = createServer({ idleTimeout: 0 }, () => new Root());
  const serverSides: Transport[] = [];
  const client = createClient<typeof gpc>(
    { reconnect: { initialDelay: 1, maxRetries: 3, multiplier: 1 } },
    () => {
      const [st, ct] = createMockTransportPair();
      serverSides.push(st);
      gpc.handle(st, {});
      return ct;
    },
  );

  const handle = client.root.feed.updates("A", 0);
  handle.resume = (() => {
    throw new Error("resume blew up");
  }) as unknown as NonNullable<typeof handle.resume>;
  const iter = handle[Symbol.asyncIterator]();
  await iter.next();
  const pending = iter.next();

  serverSides[0]!.close();
  await waitForEvent(client, "reconnect");

  const result = await Promise.race([
    pending.then(
      () => "resolved",
      (e) => e,
    ),
    timeoutAfter(500, "hang" as const),
  ]);
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toBe("resume blew up");
  client.close();
});

test("cancelling a partially-consumed stream clears its pending credit timer", async () => {
  const timers = fakeTimers();
  const gpc = createServer(
    { idleTimeout: 0, pingInterval: 0 },
    () => new Root(),
  );
  const client = createClient<typeof gpc>({ reconnect: false, timers }, () =>
    mockConnect(gpc, {}),
  );
  await client.ready;

  const iter = client.root.feed.updates("X")[Symbol.asyncIterator]();
  const first = await iter.next();
  expect(first.done).toBe(false);
  // Consuming a partial credit window armed the 100ms credit timer.
  expect(timers.pending()).toBeGreaterThanOrEqual(1);

  // Cancelling must clear it (it was previously cleared only on disconnect/close,
  // leaving a dangling timer that kept the ended stream's state reachable).
  await iter.return!();
  expect(timers.pending()).toBe(0);

  client.close();
});
