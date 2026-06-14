import { expect, test } from "bun:test";
import { z } from "zod";
import { createClient, subscribe } from "./client";
import { edge, method } from "./decorators";
import { ref } from "./ref";
import type { Reference } from "./reference";
import { createServer } from "./server";
import { flush, mockConnect } from "./test-utils";
import { canonicalPath, Node } from "./types";

class Child extends Node {
  id: string;
  constructor(id: string) {
    super();
    this.id = id;
  }
  static [canonicalPath](root: Api, id: string) {
    return root.child(id);
  }
}

class Api extends Node {
  @edge(Child, z.string())
  child(id: string): Child {
    return new Child(id);
  }

  // Returns multiple refs — all children of root — in one message.
  @method
  async refreshTwo(): Promise<Reference<Child>[]> {
    return [await ref(Child, "a"), await ref(Child, "b")];
  }
}

test("a message carrying multiple refs notifies a shared ancestor subscriber once", async () => {
  const server = createServer({}, () => new Api());
  const client = createClient<typeof server>({ reconnect: false }, () =>
    mockConnect(server, {}),
  );

  let notifications = 0;
  const unsub = subscribe(client.root, () => {
    notifications++;
  });
  await flush();

  // Ignore the initial synchronous emit from subscribe().
  notifications = 0;

  // One method call returns two refs, both children of root. The root
  // subscriber is a shared ancestor of both — it must fire once for this
  // message, not once per ref.
  await client.root.refreshTwo();
  await flush();

  expect(notifications).toBe(1);
  unsub();
});
