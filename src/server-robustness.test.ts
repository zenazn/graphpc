import { afterEach, beforeEach, expect, test } from "bun:test";
import { createServer } from "./server";
import { createMockTransportPair, type Transport } from "./protocol";
import { createSerializer } from "./serialization";
import { Node } from "./types";
import { edge, method, stream } from "./decorators";
import { getContext } from "./context";
import { RpcError } from "./errors";
import { fakeTimers } from "./test-utils";

class CustomRpcError extends RpcError {
  constructor() {
    super("CUSTOM", "custom failure");
  }
}
class NotSerializable {
  fn = () => 1;
}

const ser = createSerializer();

class Child extends Node {}
class Feed extends Node {
  @stream
  async *ticks(signal: AbortSignal): AsyncGenerator<number> {
    let i = 0;
    while (!signal.aborted) {
      yield i++;
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  @stream
  async *whoTicks(signal: AbortSignal): AsyncGenerator<unknown> {
    let i = 0;
    while (!signal.aborted && i < 6) {
      const ctx = getContext() as { who?: string };
      yield { i: i++, who: ctx.who };
      await new Promise((r) => setTimeout(r, 0));
    }
  }
}
class Api extends Node {
  @edge(Child) get child(): Child {
    return new Child();
  }
  @edge(Feed) get feed(): Feed {
    return new Feed();
  }
  @method
  async throwsCustomRpcError(): Promise<void> {
    throw new CustomRpcError();
  }
  @method
  async returnsNonSerializable(): Promise<NotSerializable> {
    return new NotSerializable();
  }
  @method
  async ok(): Promise<string> {
    return "ok";
  }
}

function connect(
  opts: Parameters<typeof createServer>[0] = {},
  ctx: object = {},
) {
  const [st, ct] = createMockTransportPair();
  const recv: string[] = [];
  ct.addEventListener("message", (e) => recv.push(e.data));
  const server = createServer(
    { idleTimeout: 0, pingInterval: 0, rateLimit: false, ...opts },
    () => new Api(),
  );
  server.handle(st as Transport, ctx);
  return { ct, recv, server };
}

const flush = () => new Promise((r) => setTimeout(r, 15));

// Guard: a synchronous throw in the message handler escapes as an uncaught
// exception. Catch it so we can assert on it instead of crashing the runner.
let uncaught: unknown[] = [];
const onUncaught = (e: unknown) => uncaught.push(e);
beforeEach(() => {
  uncaught = [];
  process.on("uncaughtException", onUncaught);
});
afterEach(() => {
  process.off("uncaughtException", onUncaught);
});

test("edge off a poisoned parent token returns an error, not an uncaught crash", async () => {
  const { ct, recv } = connect();
  await flush();
  recv.length = 0;

  // 1) edge off an invalid parent token -> server poisons token 1
  ct.send(ser.stringify({ op: "edge", tok: 999999, edge: "child" }));
  await flush();

  // 2) edge off the poisoned token 1 -> historically threw synchronously in
  //    ensureEntry (no live NodeEntry for the poison path), crashing the
  //    connection handler and hanging the client.
  recv.length = 0;
  ct.send(ser.stringify({ op: "edge", tok: 1, edge: "child" }));
  await flush();

  expect(uncaught, `uncaught: ${uncaught.map(String)}`).toHaveLength(0);
  // The client must get *some* response (an error), never silence.
  const parsed = recv.map((r) => ser.parse(r) as { op: string; re?: number });
  const reply = parsed.find((m) => m.op === "edge");
  expect(
    reply,
    "expected an edge response for the second message",
  ).toBeDefined();
  expect("error" in (reply as object)).toBe(true);
});

async function navigateToFeed(ct: Transport, recv: string[]) {
  ct.send(ser.stringify({ op: "edge", tok: 0, edge: "feed" })); // -> token 1
  await flush();
  recv.length = 0;
}

test("maxStreams is enforced against a concurrent stream_start burst (TOCTOU)", async () => {
  const { ct, recv } = connect({ maxStreams: 2 });
  await flush();
  await navigateToFeed(ct, recv);

  // Fire 10 stream_start messages in the same tick on the feed token.
  for (let k = 0; k < 10; k++) {
    ct.send(
      ser.stringify({
        op: "stream_start",
        tok: 1,
        stream: "ticks",
        credits: 4,
      }),
    );
  }
  await flush();
  await flush();

  const replies = recv
    .map((r) => ser.parse(r) as { op: string; error?: unknown })
    .filter((m) => m.op === "stream_start");
  const ok = replies.filter((m) => !("error" in m));
  const limited = replies.filter((m) => "error" in m);
  expect(ok.length).toBe(2);
  expect(limited.length).toBe(8);
});

test("stream churn does not leak abort listeners on the connection signal", async () => {
  let net = 0;
  const add = AbortSignal.prototype.addEventListener;
  const rem = AbortSignal.prototype.removeEventListener;
  AbortSignal.prototype.addEventListener = function (
    this: AbortSignal,
    t: string,
    ...r: unknown[]
  ) {
    if (t === "abort") net++;
    return (add as Function).call(this, t, ...r);
  } as typeof add;
  AbortSignal.prototype.removeEventListener = function (
    this: AbortSignal,
    t: string,
    ...r: unknown[]
  ) {
    if (t === "abort") net--;
    return (rem as Function).call(this, t, ...r);
  } as typeof rem;
  try {
    const { ct, recv } = connect();
    await flush();
    await navigateToFeed(ct, recv);
    const baseline = net;
    const N = 60;
    for (let k = 0; k < N; k++) {
      const sid = -(k + 1); // server assigns -1, -2, ... in order
      ct.send(
        ser.stringify({
          op: "stream_start",
          tok: 1,
          stream: "ticks",
          credits: 2,
        }),
      );
      await flush();
      ct.send(ser.stringify({ op: "stream_cancel", sid }));
      await flush();
    }
    const growth = net - baseline;
    expect(growth).toBeLessThan(N / 4);
  } finally {
    AbortSignal.prototype.addEventListener = add;
    AbortSignal.prototype.removeEventListener = rem;
  }
});

// Sends a get for `name` on root and returns the parsed reply (or null on hang).
async function callMethod(ct: Transport, recv: string[], name: string) {
  recv.length = 0;
  ct.send(ser.stringify({ op: "get", tok: 0, name }));
  await flush();
  await flush();
  const reply = recv
    .map((r) => ser.parse(r) as { op: string; re?: number; data?: unknown })
    .find((m) => m.op === "get");
  return reply ?? null;
}

test("throwing an unregistered RpcError subclass settles the client (no hang)", async () => {
  const { ct, recv } = connect();
  await flush();
  const reply = await callMethod(ct, recv, "throwsCustomRpcError");
  expect(reply, "client must receive a response, not hang").not.toBeNull();
  expect("error" in (reply as object)).toBe(true);
  const err = (reply as unknown as { error: unknown }).error;
  expect(err).toBeInstanceOf(RpcError);
  // Message is preserved per the documented unregistered-error contract.
  expect((err as RpcError).message).toBe("custom failure");
});

test("returning a non-serializable value settles the client with an error (no hang)", async () => {
  const { ct, recv } = connect();
  await flush();
  const reply = await callMethod(ct, recv, "returnsNonSerializable");
  expect(reply, "client must receive a response, not hang").not.toBeNull();
  expect("error" in (reply as object)).toBe(true);
  // A subsequent valid call must still work (connection stays usable).
  const ok = await callMethod(ct, recv, "ok");
  expect((ok as { data?: unknown })?.data).toBe("ok");
});

test("getContext() works inside a stream across credit-driven resumes", async () => {
  const { ct, recv } = connect({}, { who: "alice" });
  await flush();
  await navigateToFeed(ct, recv);

  // Start with 2 credits so the pump pauses, then grant more from fresh
  // message-handler ticks (which historically ran outside runWithSession).
  ct.send(
    ser.stringify({
      op: "stream_start",
      tok: 1,
      stream: "whoTicks",
      credits: 2,
    }),
  );
  await flush();
  ct.send(ser.stringify({ op: "stream_credit", sid: -1, credits: 2 }));
  await flush();
  ct.send(ser.stringify({ op: "stream_credit", sid: -1, credits: 2 }));
  await flush();

  const parsed = recv.map(
    (r) => ser.parse(r) as { op: string; data?: unknown },
  );
  const frames = parsed.filter((m) => m.op === "stream_data");
  const errorEnds = parsed.filter(
    (m) => m.op === "stream_end" && "error" in (m as object),
  );
  expect(errorEnds.length).toBe(0);
  expect(frames.length).toBeGreaterThanOrEqual(4);
  expect(
    frames.every((f) => (f.data as { who?: string }).who === "alice"),
  ).toBe(true);
});

test("ops on live tokens succeed after LRU eviction (entry rebuild restores refcounts)", async () => {
  const timers = fakeTimers();
  const { ct, recv } = connect({ lruTTL: 1, timers });
  await flush();
  recv.length = 0;

  // Two live tokens for the same path.
  ct.send(ser.stringify({ op: "edge", tok: 0, edge: "feed" })); // → token 1
  ct.send(ser.stringify({ op: "edge", tok: 0, edge: "feed" })); // → token 2
  await flush(); // real time advances past the 1ms TTL

  timers.fireAll(); // LRU sweep evicts the unpinned entry
  await flush();
  recv.length = 0;

  // Both tokens are still in the window; each op must transparently rebuild
  // the evicted entry and succeed.
  ct.send(ser.stringify({ op: "data", tok: 1 }));
  ct.send(ser.stringify({ op: "data", tok: 2 }));
  await flush();

  const parsed = recv.map(
    (r) => ser.parse(r) as { op: string; error?: unknown },
  );
  const datas = parsed.filter((m) => m.op === "data");
  expect(datas).toHaveLength(2);
  for (const d of datas) {
    expect("error" in d).toBe(false);
  }
});

test("fireLruEviction evicts all expired nodes in one sweep (no early termination when a child is the captured predecessor)", async () => {
  const timers = fakeTimers();
  let cCount = 0;

  class Leaf extends Node {
    value = "leaf";
  }
  class Mid extends Node {
    @edge(Leaf) get leaf(): Leaf {
      return new Leaf();
    }
  }
  class Root extends Node {
    @edge(Mid) get a(): Mid {
      return new Mid();
    }
    @edge(Leaf) get c(): Leaf {
      cCount++;
      return new Leaf();
    }
  }

  const [st, ct] = createMockTransportPair();
  const recv: string[] = [];
  ct.addEventListener("message", (e) => recv.push(e.data));
  const server = createServer(
    {
      idleTimeout: 0,
      pingInterval: 0,
      rateLimit: false,
      maxOperationTimeout: 0,
      lruTTL: 5,
      timers,
    },
    () => new Root(),
  );
  server.handle(st as Transport, {});
  await flush();

  // Tokens are assigned sequentially: a→1, leaf→2, c→3. B (leaf) is a child of
  // A (mid); C is a sibling under root.
  ct.send(ser.stringify({ op: "edge", tok: 0, edge: "a" })); // token 1 (A = Mid)
  ct.send(ser.stringify({ op: "edge", tok: 1, edge: "leaf" })); // token 2 (B, child of A)
  ct.send(ser.stringify({ op: "edge", tok: 0, edge: "c" })); // token 3 (C, sibling)
  await flush();
  expect(cCount).toBe(1); // c resolved once during navigation

  // Pull the nodes into the LRU list (entries enter it on data/get access, not
  // at edge time). Access order A, B, C makes the recency order tail→head =
  // A, B, C — so the sweep visits A first and B (A's child) is A's captured
  // predecessor.
  ct.send(ser.stringify({ op: "data", tok: 1 }));
  ct.send(ser.stringify({ op: "data", tok: 2 }));
  ct.send(ser.stringify({ op: "data", tok: 3 }));
  await flush();
  expect(cCount).toBe(1); // data ops reuse the resolved nodes; no re-run

  // All entries are now older than lruTTL (flush waited 15ms > 5ms). Fire the
  // LRU sweep exactly once. With the early-termination bug, evicting A removes
  // its child B (the captured predecessor) and the walk stops, skipping C.
  timers.fire();
  await flush();

  // Re-access C via its still-valid token. If C was correctly evicted, this
  // rebuilds and re-resolves it (c getter runs again → cCount 2). If C was
  // skipped, the cached entry answers and the getter does not re-run.
  recv.length = 0;
  ct.send(ser.stringify({ op: "data", tok: 3 }));
  await flush();
  const datas = recv
    .map((r) => ser.parse(r) as { op: string })
    .filter((m) => m.op === "data");
  expect(datas).toHaveLength(1);
  expect(cCount).toBe(2);
});

test("a failed stream_start success-frame send releases the slot and pins (no maxStreams leak)", async () => {
  const [st, ct] = createMockTransportPair();
  const recv: string[] = [];
  ct.addEventListener("message", (e) => recv.push(e.data));

  // Throw exactly once, on the first stream_start SUCCESS frame, to simulate a
  // socket that errors mid-send after the stream has been registered (slot
  // taken, path pinned).
  let thrown = false;
  const origSend = st.send.bind(st);
  (st as Transport).send = (data: string) => {
    if (!thrown) {
      const m = ser.parse(data) as { op: string; error?: unknown };
      if (m.op === "stream_start" && m.error === undefined) {
        thrown = true;
        throw new Error("socket write failed");
      }
    }
    origSend(data);
  };

  const server = createServer(
    { idleTimeout: 0, pingInterval: 0, rateLimit: false, maxStreams: 1 },
    () => new Api(),
  );
  server.handle(st as Transport, {});
  await flush();

  ct.send(ser.stringify({ op: "edge", tok: 0, edge: "feed" })); // token 1
  await flush();
  // First stream: its success frame send throws after registration.
  ct.send(
    ser.stringify({ op: "stream_start", tok: 1, stream: "ticks", credits: 4 }),
  );
  await flush();

  // The single stream slot must have been reclaimed. A second stream_start must
  // be admitted — not rejected with STREAM_LIMIT_EXCEEDED (which would mean the
  // failed first stream leaked its slot).
  recv.length = 0;
  ct.send(
    ser.stringify({ op: "stream_start", tok: 1, stream: "ticks", credits: 4 }),
  );
  await flush();
  const startResp = recv
    .map((r) => ser.parse(r) as { op: string; error?: { code?: string } })
    .find((m) => m.op === "stream_start");
  expect(startResp).toBeDefined();
  expect(startResp!.error?.code).not.toBe("STREAM_LIMIT_EXCEEDED");
});

test("a throwing 'error' handler does not break the handler loop", async () => {
  const server = createServer(
    { idleTimeout: 0, pingInterval: 0 },
    () => new Child(),
  );
  const calls: string[] = [];
  server.on("error", () => {
    calls.push("first");
    throw new Error("handler boom");
  });
  server.on("error", () => {
    calls.push("second");
  });

  const [st, ct] = createMockTransportPair();
  server.handle(st, {});
  await flush();

  // Malformed frame drives the parse-error path → emitError.
  ct.send("not-valid-devalue{{{");
  await flush();

  // The second handler still ran: the throw from the first didn't break the
  // loop (and didn't escape into the transport callback).
  expect(calls).toEqual(["first", "second"]);
});
