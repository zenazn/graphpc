import { expect, test } from "bun:test";
import { createClient } from "./client";
import { RpcError } from "./errors";
import { createMockTransportPair, type Transport } from "./protocol";
import { createSerializer } from "./serialization";
import { flush } from "./test-utils";

const serializer = createSerializer();

// A hand-rolled "server" that lets us return deliberately malformed frames.
function fakeServer(
  st: Transport,
  onRequest: (msg: Record<string, unknown>, re: number) => void,
) {
  let clientMsgId = 0;
  st.addEventListener("message", (e) => {
    const m = serializer.parse(e.data) as Record<string, unknown>;
    // Mirror the real server's implicit request counter.
    if (m.op === "pong" || m.op === "stream_credit" || m.op === "stream_cancel")
      return;
    clientMsgId++;
    onRequest(m, clientMsgId);
  });
  st.send(
    serializer.stringify({
      op: "hello",
      version: 2,
      tokenWindow: 10000,
      maxStreams: 32,
      schema: [{ edges: {}, streams: [] }],
    }),
  );
}

test("a non-object data payload rejects the caller instead of hanging", async () => {
  const [st, ct] = createMockTransportPair();
  fakeServer(st, (m, re) => {
    if (m.op === "data") {
      // Malformed: data should be an object, not a primitive.
      st.send(serializer.stringify({ op: "data", tok: m.tok, re, data: 42 }));
    }
  });

  const client = createClient<any>({ reconnect: false }, () => ct);
  await flush();

  let caught: unknown;
  try {
    await client.root;
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(RpcError);
  expect((caught as RpcError).code).toBe("PROTOCOL_ERROR");
});

test("ready rejects when a reconnect-disabled connection closes before hello", async () => {
  // With reconnect disabled, a transport that dies before sending `hello` leaves
  // `ready` with no way to ever resolve. It must reject rather than hang forever.
  const [st, ct] = createMockTransportPair();
  const client = createClient<any>({ reconnect: false }, () => ct);
  const readyPromise = client.ready; // triggers ensureConnected → wires ct
  await flush();

  st.close(); // no hello was ever sent; fires 'close' on ct

  let caught: unknown;
  try {
    await readyPromise;
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(RpcError);
  expect((caught as RpcError).code).toBe("CONNECTION_CLOSED");
});

test("subsequent messages still dispatch after a malformed data frame", async () => {
  // The throw must not escape the message listener and break dispatch.
  const [st, ct] = createMockTransportPair();
  let dataCount = 0;
  fakeServer(st, (m, re) => {
    if (m.op === "data") {
      dataCount++;
      const data = dataCount === 1 ? 42 : { ok: true };
      st.send(serializer.stringify({ op: "data", tok: m.tok, re, data }));
    }
  });

  const client = createClient<any>({ reconnect: false }, () => ct);
  await flush();

  // First load: malformed → rejects.
  let firstErr: unknown;
  try {
    await client.root;
  } catch (e) {
    firstErr = e;
  }
  expect(firstErr).toBeInstanceOf(RpcError);

  // Second load on a fresh stub: dispatch is still alive, returns the object.
  const result = (await client.root) as Record<string, unknown>;
  expect(result.ok).toBe(true);
});
