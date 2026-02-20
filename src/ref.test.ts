import { test, expect } from "bun:test";
import { z } from "zod";
import { edge, hidden } from "./decorators.ts";
import {
  Reference,
  ref,
  isReference,
  createRecordingProxy,
  getRecordedPath,
  walkPath,
} from "./ref.ts";
import { resolveData } from "./resolve.ts";
import { EdgeNotFoundError } from "./errors.ts";
import { canonicalPath, Node } from "./types.ts";
import { runWithSession, type Session } from "./context.ts";

class Tweet extends Node {
  id: string;
  text: string;
  constructor(id: string, text: string) {
    super();
    this.id = id;
    this.text = text;
  }

  static [canonicalPath](root: Api, id: string) {
    return root.tweets.get(id);
  }
}

class TweetsService extends Node {
  @edge(Tweet, z.string())
  get(id: string): Tweet {
    return new Tweet(id, `tweet ${id}`);
  }
}

class Api extends Node {
  @edge(TweetsService)
  get tweets(): TweetsService {
    return new TweetsService();
  }
}

test("isReference detects References", () => {
  expect(
    isReference(
      new Reference(["tweets", ["get", "1"]], { id: "1", text: "hi" }),
    ),
  ).toBe(true);
  expect(isReference("not a ref")).toBe(false);
  expect(isReference(null)).toBe(false);
});

test("recording proxy captures getter edge path", () => {
  const proxy = createRecordingProxy();
  const result = proxy.tweets;
  expect(getRecordedPath(result)).toEqual(["tweets"]);
});

test("recording proxy captures method edge path with args", () => {
  const proxy = createRecordingProxy();
  const result = proxy.tweets.get("42");
  expect(getRecordedPath(result)).toEqual(["tweets", ["get", "42"]]);
});

test("ref() creates a Reference via canonicalPath + ALS", async () => {
  const api = new Api();
  const session: Session = {
    ctx: {},
    root: api,
    nodeCache: new Map(),
    close: () => {},
    reducers: undefined,
    signal: new AbortController().signal,
  };

  const result = await runWithSession(session, () => ref(Tweet, "42"));
  expect(result).toBeInstanceOf(Reference);
  expect(result.path).toEqual(["tweets", ["get", "42"]]);
  expect(result.data).toEqual({ id: "42", text: "tweet 42" });
});

test("ref() throws outside of a request", async () => {
  expect(ref(Tweet, "1")).rejects.toThrow(
    "getSession() called outside of a request",
  );
});

test("resolveData gets own properties", () => {
  const tweet = new Tweet("1", "hi");
  expect(resolveData(tweet, {})).toEqual({ id: "1", text: "hi" });
});

test("walkPath resolves edges and uses cache", async () => {
  const api = new Api();
  const cache = new Map<string, Promise<object>>();

  const tweet = await walkPath(
    api,
    ["tweets", ["get", "1"]],
    cache,
    undefined,
    {},
  );
  expect(tweet).toBeInstanceOf(Tweet);
  expect((tweet as Tweet).id).toBe("1");

  // Cache should have entries
  expect(cache.size).toBe(2); // tweets service + tweet

  // Walking again with the same cache reuses entries
  const tweet2 = await walkPath(
    api,
    ["tweets", ["get", "1"]],
    cache,
    undefined,
    {},
  );
  expect(tweet2).toBe(tweet); // same cached instance
});

test("ref() throws when class has no [canonicalPath] method", async () => {
  class NoPath {
    name = "test";
  }

  const session: Session = {
    ctx: {},
    root: new Api(),
    nodeCache: new Map(),
    close: () => {},
    reducers: undefined,
    signal: new AbortController().signal,
  };
  expect(runWithSession(session, () => ref(NoPath as any))).rejects.toThrow(
    "Class NoPath does not have a [canonicalPath] method",
  );
});

test("ref() throws with correct message when [canonicalPath] returns non-proxy", async () => {
  class BadPath {
    name = "test";
    static [canonicalPath]() {
      return "not a proxy";
    }
  }

  const session: Session = {
    ctx: {},
    root: new Api(),
    nodeCache: new Map(),
    close: () => {},
    reducers: undefined,
    signal: new AbortController().signal,
  };
  expect(runWithSession(session, () => ref(BadPath as any))).rejects.toThrow(
    "[canonicalPath] for BadPath did not return a recorded proxy",
  );
});

test("node caching: multiple ref() calls sharing intermediate edges reuse cached nodes", async () => {
  const api = new Api();
  const session: Session = {
    ctx: {},
    root: api,
    nodeCache: new Map(),
    close: () => {},
    reducers: undefined,
    signal: new AbortController().signal,
  };

  const [r1, r2] = await runWithSession(session, async () => {
    return Promise.all([ref(Tweet, "1"), ref(Tweet, "2")]);
  });

  expect(r1.path).toEqual(["tweets", ["get", "1"]]);
  expect(r2.path).toEqual(["tweets", ["get", "2"]]);
  // Both share the cached "tweets" intermediate edge
  expect(session.nodeCache.size).toBe(3); // tweets, tweet 1, tweet 2
});

// -- @hidden enforcement in walkPath and ref() --

class SecretNode extends Node {
  secret = "classified";
}

class HiddenEdgeApi extends Node {
  @hidden((ctx: any) => !ctx.isAdmin)
  @edge(SecretNode)
  get secret(): SecretNode {
    return new SecretNode();
  }
}

test("walkPath throws EdgeNotFoundError for @hidden edge when ctx lacks permission", async () => {
  const api = new HiddenEdgeApi();
  const cache = new Map<string, Promise<object>>();
  const ctx = { isAdmin: false };

  expect(
    walkPath(api, ["secret"], cache, undefined, ctx),
  ).rejects.toBeInstanceOf(EdgeNotFoundError);
});

test("walkPath traverses @hidden edge when ctx has permission", async () => {
  const api = new HiddenEdgeApi();
  const cache = new Map<string, Promise<object>>();
  const ctx = { isAdmin: true };

  const node = await walkPath(api, ["secret"], cache, undefined, ctx);
  expect(node).toBeInstanceOf(SecretNode);
});

class NodeWithHiddenProp extends Node {
  visible = "public";
  @hidden((ctx: any) => !ctx.isAdmin)
  get sensitiveData() {
    return "admin-only";
  }
}

class HiddenPropApi extends Node {
  @edge(NodeWithHiddenProp)
  get item(): NodeWithHiddenProp {
    return new NodeWithHiddenProp();
  }

  static [canonicalPath](root: HiddenPropApi) {
    return root.item;
  }
}

test("ref() data excludes @hidden properties when ctx lacks permission", async () => {
  const api = new HiddenPropApi();
  const session: Session = {
    ctx: { isAdmin: false },
    root: api,
    nodeCache: new Map(),
    close: () => {},
    reducers: undefined,
    signal: new AbortController().signal,
  };

  const result = await runWithSession(session, () => ref(HiddenPropApi));
  expect(result.data.visible).toBe("public");
  expect(result.data.sensitiveData).toBeUndefined();
});

test("ref() data includes @hidden properties when ctx has permission", async () => {
  const api = new HiddenPropApi();
  const session: Session = {
    ctx: { isAdmin: true },
    root: api,
    nodeCache: new Map(),
    close: () => {},
    reducers: undefined,
    signal: new AbortController().signal,
  };

  const result = await runWithSession(session, () => ref(HiddenPropApi));
  expect(result.data.visible).toBe("public");
  expect(result.data.sensitiveData).toBe("admin-only");
});

// -- walkPath with failed intermediate edges --

class FailingGetService extends Node {
  @edge(Tweet, z.string())
  get(id: string): Tweet {
    throw new Error(`Post ${id} not found`);
  }
}

class FailingApi extends Node {
  @edge(FailingGetService)
  get posts(): FailingGetService {
    return new FailingGetService();
  }
}

test("walkPath propagates error when intermediate edge throws", async () => {
  const api = new FailingApi();
  const cache = new Map<string, Promise<object>>();

  expect(
    walkPath(api, ["posts", ["get", "999"]], cache, undefined, {}),
  ).rejects.toThrow("Post 999 not found");
});

test("walkPath caches the failed promise so retries see the same rejection", async () => {
  const api = new FailingApi();
  const cache = new Map<string, Promise<object>>();

  // First attempt — should fail
  const err1 = await walkPath(
    api,
    ["posts", ["get", "999"]],
    cache,
    undefined,
    {},
  ).catch((e) => e);
  expect(err1).toBeInstanceOf(Error);
  expect((err1 as Error).message).toBe("Post 999 not found");

  // Cache should contain entries for both the intermediate and failing edge
  expect(cache.size).toBe(2);

  // Second attempt with same cache — should get the same cached rejection
  const err2 = await walkPath(
    api,
    ["posts", ["get", "999"]],
    cache,
    undefined,
    {},
  ).catch((e: Error) => e);
  expect(err2).toBe(err1); // exact same error instance from cached promise
});

class BrokenTarget extends Node {}

class AlwaysFailApi extends Node {
  @edge(BrokenTarget)
  get broken(): BrokenTarget {
    throw new EdgeNotFoundError("broken");
  }
}

test("walkPath propagates EdgeNotFoundError from first segment", async () => {
  const api = new AlwaysFailApi();
  const cache = new Map<string, Promise<object>>();

  expect(
    walkPath(api, ["broken"], cache, undefined, {}),
  ).rejects.toBeInstanceOf(EdgeNotFoundError);
});

// -- ref() after mutation invalidates leaf cache --

class MutableItem extends Node {
  id: string;
  name: string;
  constructor(id: string, name: string) {
    super();
    this.id = id;
    this.name = name;
  }

  static [canonicalPath](root: MutableApi, id: string) {
    return root.items.get(id);
  }
}

class MutableItemsService extends Node {
  store: Map<string, string>;
  constructor(store: Map<string, string>) {
    super();
    this.store = store;
  }

  @edge(MutableItem, z.string())
  get(id: string): MutableItem {
    return new MutableItem(id, this.store.get(id) ?? "unknown");
  }
}

class MutableApi extends Node {
  store: Map<string, string>;
  constructor(store: Map<string, string>) {
    super();
    this.store = store;
  }

  @edge(MutableItemsService)
  get items(): MutableItemsService {
    return new MutableItemsService(this.store);
  }
}

test("ref() returns fresh data after mutation (leaf cache eviction)", async () => {
  const store = new Map([["1", "original"]]);
  const api = new MutableApi(store);
  const session: Session = {
    ctx: {},
    root: api,
    nodeCache: new Map(),
    close: () => {},
    reducers: undefined,
    signal: new AbortController().signal,
  };

  // First ref populates cache
  const r1 = await runWithSession(session, () => ref(MutableItem, "1"));
  expect(r1.data).toEqual({ id: "1", name: "original" });

  // Mutate backing store
  store.set("1", "updated");

  // Second ref should see the mutation (leaf evicted, re-resolved)
  const r2 = await runWithSession(session, () => ref(MutableItem, "1"));
  expect(r2.data).toEqual({ id: "1", name: "updated" });

  // Intermediate edge ("items") should still be cached (3 entries: items + item@1 twice resolved)
  // The items service is cached, only the leaf was evicted and re-resolved
  expect(session.nodeCache.has("root.items")).toBe(true);
});

test("walkPath caches failure at first segment", async () => {
  const api = new AlwaysFailApi();
  const cache = new Map<string, Promise<object>>();

  await walkPath(api, ["broken"], cache, undefined, {}).catch(() => {});
  expect(cache.size).toBe(1);

  // Cached promise should still reject (get the single entry from the cache)
  const cachedPromise = cache.values().next().value;
  expect(cachedPromise).rejects.toBeInstanceOf(EdgeNotFoundError);
});
