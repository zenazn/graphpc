import { expect, test } from "bun:test";
import { createClient, invalidate, subscribe } from "./client";
import type { Transport } from "./protocol";
import { pathTo } from "./ref";
import { runWithSession, type Session } from "./context";
import { Node, canonicalPath } from "./types";
import { edge } from "./decorators";

// A transport that never delivers anything — exercises pure client cache logic.
function deadTransport(): Transport {
  return {
    send() {},
    close() {},
    addEventListener() {},
    removeEventListener() {},
  };
}

test("double-unsubscribe must not kill a newer subscriber on the same path", () => {
  const client = createClient({ reconnect: false }, deadTransport);
  const post = (
    client.root as unknown as { posts: { get(id: string): unknown } }
  ).posts.get("1");

  let sub2Calls = 0;
  const unsub1 = subscribe(post, () => {});
  unsub1(); // removes sub1 and the path's subscriber set
  const unsub2 = subscribe(post, () => {
    sub2Calls++;
  }); // creates a fresh set under the same key
  unsub1(); // stale double-unsubscribe — must not delete sub2's set

  sub2Calls = 0; // ignore subscribe()'s synchronous initial call
  invalidate(post);
  expect(sub2Calls).toBe(1);
  unsub2();
});

class SessionUser extends Node {
  constructor(public who: string) {
    super();
  }
  static [canonicalPath](root: { user: SessionUser }) {
    return root.user;
  }
}
class SessionRoot extends Node {
  constructor(private who: string) {
    super();
  }
  @edge(SessionUser) get user(): SessionUser {
    return new SessionUser(this.who);
  }
}

function makeSession(who: string): Session {
  return {
    ctx: {},
    root: new SessionRoot(who),
    nodeCache: new Map(),
    close: () => {},
    signal: new AbortController().signal,
  };
}

test("a reused Path resolves against the current session, not a memoized one", async () => {
  const p = pathTo(SessionUser); // built once, reused across connections
  const a = await runWithSession(makeSession("alice"), async () => await p);
  const b = await runWithSession(makeSession("bob"), async () => await p);
  expect((a as SessionUser).who).toBe("alice");
  expect((b as SessionUser).who).toBe("bob");
});
