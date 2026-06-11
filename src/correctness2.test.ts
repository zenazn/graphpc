import { test, expect } from "bun:test";
import { z } from "zod";
import { createServer } from "./server";
import { createClient, subscribe } from "./client";
import { ref, Reference } from "./ref";
import { createMockTransportPair, type Transport } from "./protocol";
import { Node, canonicalPath } from "./types";
import { edge, method } from "./decorators";
import { flush } from "./test-utils";

class Item extends Node {
  constructor(public id: string) {
    super();
  }
  static [canonicalPath](root: { item(id: string): Item }, id: string) {
    return root.item(id);
  }
}
class Api extends Node {
  @edge(Item, z.string()) item(id: string): Item {
    return new Item(id);
  }
  @method(z.string()) async touch(id: string): Promise<Reference<Item>> {
    return ref(Item, id);
  }
}

test("a throwing subscriber does not tear down the connection", async () => {
  const gpc = createServer({}, () => new Api());
  const client = createClient<typeof gpc>({ reconnect: false }, () => {
    const [st, ct] = createMockTransportPair();
    gpc.handle(st, {});
    return ct as Transport;
  });
  await client.ready;
  const root = client.root as unknown as {
    item(id: string): unknown;
    touch(id: string): Promise<unknown>;
  };
  let calls = 0;
  const origError = console.error;
  console.error = () => {}; // silence the expected out-of-band report
  try {
    subscribe(root.item("1"), () => {
      calls++;
      if (calls > 1) throw new Error("subscriber boom");
    });
    await root.touch("1"); // ref revival notifies the subscriber, which throws
    await flush();
    const r = await root.touch("1"); // connection must still work
    expect(r).toBeDefined();
  } finally {
    console.error = origError;
  }
});
