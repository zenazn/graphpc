import { expect, test } from "bun:test";
import { z } from "zod";
import { createClient, subscribe } from "./client";
import { edge, stream } from "./decorators";
import { ref } from "./ref";
import type { OperationResult } from "./hooks";
import { createServer } from "./server";
import { flush, mockConnect } from "./test-utils";
import { Node, canonicalPath } from "./types";

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

test("maxCacheEntries also evicts the per-path token maps (re-traversal re-resolves the edge)", async () => {
  const edgePaths: string[] = [];
  const server = createServer({}, () => new Api());
  server.on(
    "operation",
    async (_ctx, info, execute): Promise<OperationResult> => {
      if (info.op === "edge") edgePaths.push(info.path);
      return execute();
    },
  );
  const client = createClient<typeof server>(
    { reconnect: false, maxCacheEntries: 1 },
    () => mockConnect(server, {}),
  );

  await client.root.get("a"); // edge op #1 for a
  await client.root.get("b"); // a evicted (data AND its edge token)
  await client.root.get("a"); // cache miss → must re-resolve the edge
  await flush();

  const aEdges = edgePaths.filter((p) => /get\("a"\)/.test(p)).length;
  // Without dropping the edge token on eviction, the second get("a") would reuse
  // the cached token (only a data refetch, no edge op) → 1. With the maps kept
  // in sync, the edge is re-resolved → 2.
  expect(aEdges).toBe(2);
});

test("maxCacheEntries bounds ref() payloads delivered via a stream", async () => {
  const dataPaths: string[] = [];

  class RItem extends Node {
    value: number;
    constructor(public id: string) {
      super();
      this.value = Number(id);
    }
    static [canonicalPath](root: RApi, id: string) {
      return root.get(id);
    }
  }
  class RApi extends Node {
    @edge(RItem, z.string())
    get(id: string): RItem {
      return new RItem(id);
    }
    @stream
    async *refs(_signal: AbortSignal): AsyncGenerator<unknown> {
      for (let i = 0; i < 6; i++) yield await ref(RItem, String(i));
    }
  }

  const server = createServer({}, () => new RApi());
  server.on(
    "operation",
    async (_ctx, info, execute): Promise<OperationResult> => {
      if (info.op === "data") dataPaths.push(info.path);
      return execute();
    },
  );

  const client = createClient<typeof server>(
    { reconnect: false, maxCacheEntries: 1 },
    () => mockConnect(server, {}),
  );
  await client.ready;

  // Consume the whole stream — each yielded ref() carries its node data inline,
  // which the ResolvedRef reviver writes into the persistent cache.
  const handle = (
    client.root as unknown as {
      refs(): { [Symbol.asyncIterator](): AsyncIterator<unknown> };
    }
  ).refs();
  const iter = handle[Symbol.asyncIterator]();
  while (!(await iter.next()).done) {
    /* drain */
  }
  await flush();

  // That streamed ref data must be subject to maxCacheEntries: the early node
  // "0" is evicted, so reading it forces a real data fetch. Without the bound
  // applying to the stream-delivered ref path, "0" would still be cached and no
  // fetch would occur.
  await client.root.get("0");
  await flush();
  const zeroFetches = dataPaths.filter((p) => /get\("0"\)/.test(p)).length;
  expect(zeroFetches).toBe(1);
});

test("callable-edge call stubs are bounded by maxCacheEntries (cold args re-created)", () => {
  const { server } = makeServer();
  const client = createClient<typeof server>(
    { reconnect: false, maxCacheEntries: 2 },
    () => mockConnect(server, {}),
  );

  const get = (client.root as unknown as { get(id: string): object }).get;
  const s0 = get("0");
  const s1 = get("1");
  const s2 = get("2"); // 3 distinct args > cap 2 → "0" (LRU) evicted

  // Hot args keep their identity...
  expect(get("2")).toBe(s2);
  expect(get("1")).toBe(s1);
  // ...but the evicted cold arg is re-created with a fresh stub. Without the
  // bound, the per-accessor call cache grows without limit and "0" stays cached.
  expect(get("0")).not.toBe(s0);

  client.close();
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
