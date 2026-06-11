import { test, expect } from "bun:test";
import { z } from "zod";
import { createServer } from "./server";
import { createClient, evict } from "./client";
import { createMockTransportPair, type Transport } from "./protocol";
import { createSerializer } from "./serialization";
import { Node } from "./types";
import { edge } from "./decorators";
import { flush } from "./test-utils";

const ser = createSerializer();
let gate: (() => void)[] = [];

class Item extends Node {
  value = 1;
}
class Api extends Node {
  @edge(Item, z.string())
  async item(_id: string): Promise<Item> {
    await new Promise<void>((r) => gate.push(r)); // hold the edge open
    return new Item();
  }
}

test("evict during an in-flight data load forces a real re-fetch", async () => {
  gate = [];
  const gpc = createServer({}, () => new Api());
  let dataOps = 0;
  const factory = () => {
    const [st, ct] = createMockTransportPair();
    const orig = st.addEventListener.bind(st);
    st.addEventListener = ((
      type: string,
      listener: (e: { data: string }) => void,
    ) => {
      if (type === "message") {
        orig("message", (e) => {
          const m = ser.parse(e.data) as { op?: string };
          if (m && m.op === "data") dataOps++;
          listener(e);
        });
      } else {
        orig(type as "message", listener);
      }
    }) as typeof st.addEventListener;
    gpc.handle(st, {});
    return ct as Transport;
  };
  const client = createClient<typeof gpc>({ reconnect: false }, factory);
  await client.ready;
  const root = client.root as unknown as {
    item(id: string): PromiseLike<{ value: number }>;
  };

  // Start the load; the data op reaches the server but blocks on the gated edge.
  const load = root.item("1").then((d) => d);
  await flush();
  expect(dataOps).toBe(1); // data op sent, response still pending

  evict(root.item("1")); // evict while the response is genuinely in flight
  gate.forEach((r) => r()); // release the edge -> data response arrives
  await load;
  await flush();

  // A fresh read must re-fetch — the in-flight response must not have
  // resurrected the cache that evict() cleared.
  await root.item("1");
  gate.forEach((r) => r());
  await flush();
  expect(dataOps).toBe(2);
});
