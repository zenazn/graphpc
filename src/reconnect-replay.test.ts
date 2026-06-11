import { test, expect } from "bun:test";
import { z } from "zod";
import { edge, method } from "./decorators";
import { createServer } from "./server";
import { createClient } from "./client";
import { createMockTransportPair, type Transport } from "./protocol";
import { Node } from "./types";
import { flush } from "./test-utils";

let slowResolvers: (() => void)[] = [];
let bumpCount = 0;

class Api extends Node {
  @method
  async slow(): Promise<string> {
    await new Promise<void>((r) => slowResolvers.push(r));
    return "done";
  }
  @method
  async bump(): Promise<number> {
    return ++bumpCount;
  }
  @method(z.any())
  async echo(v: unknown): Promise<unknown> {
    return v;
  }
}

function setup() {
  slowResolvers = [];
  bumpCount = 0;
  const gpc = createServer({}, () => new Api());
  let current: Transport | null = null;
  const factory = () => {
    const [st, ct] = createMockTransportPair();
    current = st;
    gpc.handle(st, {});
    return ct;
  };
  const client = createClient<typeof gpc>({ reconnect: true }, factory);
  const disconnect = () => {
    current?.close();
    current = null;
  };
  return { client, disconnect };
}

test("a method awaited during the reconnect window runs exactly once", async () => {
  const { client, disconnect } = setup();

  // Keep one op in-flight so the disconnect triggers an eager reconnect.
  const slowP = Promise.resolve(client.root.slow());
  await client.ready;
  await flush();

  // Disconnect, then issue a fresh method during the reconnect window.
  disconnect();
  const bumpP = Promise.resolve(client.root.bump());

  await flush(); // reconnect (immediate first attempt) + hello + replay
  slowResolvers.forEach((r) => r()); // let slow() finish on the new connection
  await slowP;
  const n = await bumpP;

  expect(bumpCount).toBe(1); // executed once server-side
  expect(n).toBe(1);
});

test("a replayed op survives a second disconnect instead of hanging", async () => {
  const { client, disconnect } = setup();

  const slowP = Promise.resolve(client.root.slow());
  await client.ready;
  await flush();

  // First disconnect -> reconnect -> slow() replayed on the new connection.
  disconnect();
  await flush();

  // Second disconnect while the replayed slow() is in-flight.
  disconnect();
  await flush();

  // It must reconnect again and complete, not orphan-hang.
  slowResolvers.forEach((r) => r());
  const result = await slowP;
  expect(result).toBe("done");
});

test("an unserializable argument does not desync response correlation", async () => {
  const { client } = setup();
  await client.ready;

  const root = client.root as unknown as { echo(v: unknown): Promise<unknown> };

  // A function argument can't be serialized: the send must reject without
  // advancing the positional message counter.
  let threw = false;
  try {
    await root.echo(() => 1);
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);

  // Subsequent calls must still resolve with their own values, not misrouted.
  const a = await root.echo("AAA");
  const b = await root.echo("BBB");
  expect(a).toBe("AAA");
  expect(b).toBe("BBB");
});
