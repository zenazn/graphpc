import { expect, test } from "bun:test";
import { z } from "zod";
import { createClient, subscribe } from "./client";
import { edge } from "./decorators";
import type { OperationResult } from "./hooks";
import { createServer } from "./server";
import { flush, mockConnect } from "./test-utils";
import { Node } from "./types";

class Item extends Node {
  id: string;
  value = 1;
  constructor(id: string) {
    super();
    this.id = id;
  }
}

class Api extends Node {
  @edge(Item, z.string())
  get(id: string): Item {
    return new Item(id);
  }
}

function makeServer() {
  const dataPaths: string[] = [];
  const server = createServer({}, () => new Api());
  server.on(
    "operation",
    async (_ctx, info, execute): Promise<OperationResult> => {
      if (info.op === "data") dataPaths.push(info.path);
      return execute();
    },
  );
  return { server, dataPaths };
}

test("maxCacheEntries evicts unpinned nodes, forcing a re-fetch", async () => {
  const { server, dataPaths } = makeServer();
  const client = createClient<typeof server>(
    { reconnect: false, maxCacheEntries: 1 },
    () => mockConnect(server, {}),
  );

  await client.root.get("a"); // data op #1 for a
  await client.root.get("b"); // data op for b → a evicted (oldest, unpinned)
  await client.root.get("a"); // cache miss → data op #2 for a
  await flush();

  const aCount = dataPaths.filter((p) => /get\("a"\)/.test(p)).length;
  // a was loaded, evicted by b, then re-loaded.
  expect(aCount).toBe(2);
});

test("subscribed nodes are pinned and not evicted by the bound", async () => {
  const { server, dataPaths } = makeServer();
  const client = createClient<typeof server>(
    { reconnect: false, maxCacheEntries: 1 },
    () => mockConnect(server, {}),
  );

  // Keep "a" pinned via an active subscriber.
  const unsub = subscribe(client.root.get("a"), () => {});

  await client.root.get("a"); // data op #1 for a (now pinned)
  await client.root.get("b"); // exceeds cap, but a is pinned → b evicted instead
  await client.root.get("a"); // served from cache → no new data op for a
  await flush();

  const aCount = dataPaths.filter((p) => /get\("a"\)/.test(p)).length;
  expect(aCount).toBe(1);
  unsub();
});

test("default (no maxCacheEntries) keeps everything cached", async () => {
  const { server, dataPaths } = makeServer();
  const client = createClient<typeof server>({ reconnect: false }, () =>
    mockConnect(server, {}),
  );

  await client.root.get("a");
  await client.root.get("b");
  await client.root.get("a"); // cache hit → no re-fetch
  await flush();

  const aCount = dataPaths.filter((p) => /get\("a"\)/.test(p)).length;
  expect(aCount).toBe(1);
});
