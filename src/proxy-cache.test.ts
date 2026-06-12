/**
 * The stub cache key for edge-call arguments must distinguish distinct
 * custom-typed values. Before the fix, formatValue ran without the client's
 * reducers, so every instance of a custom class collapsed to "[Object]" and
 * two different arguments shared one cached stub — the second caller silently
 * received the first caller's node.
 */

import { test, expect } from "bun:test";
import { z } from "zod";
import { edge } from "./decorators";
import { createServer } from "./server";
import { createClient } from "./client";
import { createSSRClient } from "./ssr";
import { Node } from "./types";
import { mockConnect } from "./test-utils";

class UserId {
  constructor(public id: string) {}
}

const serdeOptions = {
  reducers: {
    UserId: (v: unknown) => v instanceof UserId && [v.id],
  },
  revivers: {
    UserId: (v: unknown) => new UserId((v as [string])[0]!),
  },
};

class Item extends Node {
  constructor(public label: string) {
    super();
  }
}

class Api extends Node {
  @edge(Item, z.instanceof(UserId))
  item(u: UserId): Item {
    return new Item(u.id);
  }
}

test("client: distinct custom-typed edge args get distinct stubs", async () => {
  const gpc = createServer(serdeOptions, () => new Api());
  const client = createClient<typeof gpc>(serdeOptions, () =>
    mockConnect(gpc, {}),
  );

  const a = await client.root.item(new UserId("a"));
  const b = await client.root.item(new UserId("b"));

  expect(a.label).toBe("a");
  expect(b.label).toBe("b");
  client.close();
});

test("SSR: distinct custom-typed edge args get distinct stubs", async () => {
  const gpc = createServer(serdeOptions, () => new Api());
  const client = createSSRClient<typeof gpc>(new Api(), {}, serdeOptions);

  const a = await client.root.item(new UserId("a"));
  const b = await client.root.item(new UserId("b"));

  expect(a.label).toBe("a");
  expect(b.label).toBe("b");
});
