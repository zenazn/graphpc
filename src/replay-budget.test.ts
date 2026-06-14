import { expect, test } from "bun:test";
import { createClient } from "./client";
import { RpcError, TokenExpiredError } from "./errors";
import { createMockTransportPair, type Transport } from "./protocol";
import { createSerializer } from "./serialization";
import { flush } from "./test-utils";

const serializer = createSerializer();

// The replay circuit breaker allows MAX_REPLAYS (5) consecutive TokenExpired
// retries on a path before surfacing the error. A path that takes a few
// retries then fails with a *different* error must reset its counter, so a
// later genuine expiry gets the full budget again.
test("replay counter resets after a non-TokenExpired rejection", () => {
  const [st, ct] = createMockTransportPair();

  // phase 1: 2× TokenExpired then a custom error.
  // phase 2: always TokenExpired — count how many we send before the client
  //          gives up (== full budget 6 only if the counter reset).
  let clientMsgId = 0;
  let phase = 1;
  let phase2Expired = 0;
  st.addEventListener("message", (e) => {
    const m = serializer.parse(e.data) as { op: string; tok?: number };
    if (m.op === "pong" || m.op === "stream_credit" || m.op === "stream_cancel")
      return;
    clientMsgId++;
    if (m.op !== "get") return;
    const re = clientMsgId;
    if (phase === 1) {
      // 1st & 2nd get → expired; 3rd → custom error (ends phase 1).
      const getsInPhase1 = clientMsgId; // only get ops reach here in this test
      if (getsInPhase1 <= 2) {
        st.send(
          serializer.stringify({
            op: "get",
            tok: 0,
            re,
            error: new TokenExpiredError(),
          }),
        );
      } else {
        st.send(
          serializer.stringify({
            op: "get",
            tok: 0,
            re,
            error: new RpcError("APP_ERROR", "boom"),
          }),
        );
      }
    } else {
      phase2Expired++;
      st.send(
        serializer.stringify({
          op: "get",
          tok: 0,
          re,
          error: new TokenExpiredError(),
        }),
      );
    }
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

  const client = createClient<any>({ reconnect: false }, () => ct as Transport);

  return (async () => {
    await flush();

    // Phase 1: expires twice (counter → 2), then fails with APP_ERROR.
    let firstErr: unknown;
    try {
      await (
        client.root as unknown as { someMethod(): Promise<unknown> }
      ).someMethod();
    } catch (e) {
      firstErr = e;
    }
    for (let i = 0; i < 5; i++) await flush();
    expect((firstErr as RpcError)?.code).toBe("APP_ERROR");

    // Phase 2: a fresh genuine expiry must get the full 5-replay budget, i.e.
    // the server sends 6 TokenExpired (attempts 1..6) before the breaker trips.
    phase = 2;
    let secondErr: unknown;
    try {
      await (
        client.root as unknown as { someMethod(): Promise<unknown> }
      ).someMethod();
    } catch (e) {
      secondErr = e;
    }
    for (let i = 0; i < 20; i++) await flush();
    expect(secondErr).toBeInstanceOf(TokenExpiredError);
    // 6 = MAX_REPLAYS (5) + the final attempt that trips the breaker. A leaked
    // counter (still 2 from phase 1) would trip after only 4.
    expect(phase2Expired).toBe(6);
  })();
});
