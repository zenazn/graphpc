import { test, expect } from "bun:test";
import { z } from "zod";
import { edge, method } from "./decorators.ts";
import { Node, canonicalPath, type RpcClient } from "./types.ts";
import { ref, pathTo, type Reference } from "./ref.ts";
import type { Path } from "./node-path.ts";
import { createSSRClient } from "./ssr.ts";
import { createSerializer } from "./serialization.ts";
import { createServer } from "./server.ts";
import { createClient } from "./client.ts";
import { createMockTransportPair } from "./protocol.ts";
import type { Transport } from "./protocol.ts";

// -- Test graph --

class Comment extends Node {
  constructor(
    public id: string,
    public text: string,
  ) {
    super();
  }

  @method
  async upvote(): Promise<number> {
    return 42;
  }
}

class CommentsService extends Node {
  #comments = new Map<string, Comment>([
    ["c1", new Comment("c1", "Great post!")],
    ["c2", new Comment("c2", "Thanks")],
  ]);

  @edge(Comment, z.string())
  get(id: string): Comment {
    const c = this.#comments.get(id);
    if (!c) throw new Error(`Comment ${id} not found`);
    return c;
  }
}

class Post extends Node {
  constructor(
    public id: string,
    public title: string,
  ) {
    super();
  }

  static [canonicalPath](root: Api, id: string) {
    return root.posts.get(id);
  }

  @edge(CommentsService)
  get comments(): CommentsService {
    return new CommentsService();
  }
}

class PostsService extends Node {
  #posts = new Map<string, Post>([
    ["1", new Post("1", "Hello World")],
    ["2", new Post("2", "Second Post")],
  ]);

  @edge(Post, z.string())
  get(id: string): Post {
    const post = this.#posts.get(id);
    if (!post) throw new Error(`Post ${id} not found`);
    return post;
  }

  @method
  async count(): Promise<number> {
    return this.#posts.size;
  }

  @method
  async listRefs(): Promise<Reference<Post>[]> {
    return Promise.all([ref(Post, "1"), ref(Post, "2")]);
  }

  @method
  async listPaths(): Promise<Path<Post>[]> {
    return ["1", "2"].map((id) => pathTo(Post, id));
  }
}

class Api extends Node {
  @edge(PostsService)
  get posts(): PostsService {
    return new PostsService();
  }
}

const gpc = createServer({}, (_ctx: {}) => new Api());

// -- createSSRClient tests --

test("generateHydrationData returns a string", async () => {
  const client = createSSRClient<typeof gpc>(new Api(), {});
  await client.root.posts;
  const hydrationData = client.generateHydrationData();
  expect(typeof hydrationData).toBe("string");
});

test("SSR tracking proxy records getter edge traversal", async () => {
  const client = createSSRClient<typeof gpc>(new Api(), {});

  // Navigate a getter edge
  const postsProxy = client.root.posts;
  // Await to trigger data fetch
  await postsProxy;

  const data = createSerializer().parse(client.generateHydrationData()) as any;

  // Should have one ref for the "posts" edge
  expect(data.refs.length).toBe(1);
  expect(data.refs[0]).toEqual([0, "posts"]);

  // Should have one data entry for the awaited node
  expect(data.data.length).toBe(1);
  expect(data.data[0]![0]).toBe(1); // token 1
});

test("SSR tracking proxy records method edge traversal with args", async () => {
  const client = createSSRClient<typeof gpc>(new Api(), {});

  // Navigate through method edge with args
  const postProxy = client.root.posts.get("1");
  const postData = await postProxy;

  expect(postData.id).toBe("1");
  expect(postData.title).toBe("Hello World");

  const data = createSerializer().parse(client.generateHydrationData()) as any;

  // Should have refs for posts (getter) and get("1") (method with arg)
  expect(data.refs.length).toBe(2);
  expect(data.refs[0]).toEqual([0, "posts"]);
  expect(data.refs[1]).toEqual([1, "get", "1"]);
});

test("SSR tracking proxy records method calls", async () => {
  const client = createSSRClient<typeof gpc>(new Api(), {});

  const count = await client.root.posts.count();
  expect(count).toBe(2);

  const data = createSerializer().parse(client.generateHydrationData()) as any;

  // Should have one ref for "posts" edge, and one call entry for "count"
  expect(data.refs.length).toBe(1);

  // Data should contain the call entry: [token, method, args, result]
  const callEntries = data.data.filter((d: any) => d.length === 4);
  expect(callEntries.length).toBe(1);
  expect(callEntries[0]![0]).toBe(1); // token 1 (posts)
  expect(callEntries[0]![1]).toBe("count");
  expect(callEntries[0]![2]).toEqual([]);
  expect(callEntries[0]![3]).toBe(2);
});

test("SSR tracking proxy deduplicates data entries for same node", async () => {
  const client = createSSRClient<typeof gpc>(new Api(), {});

  // Await the same node multiple times
  await client.root.posts;
  await client.root.posts;
  await client.root.posts;

  const data = createSerializer().parse(client.generateHydrationData()) as any;

  // Only one ref (edge dedup) and one data entry (data dedup)
  expect(data.refs.length).toBe(1);
  const dataOnly = data.data.filter((d: any) => d.length === 2);
  expect(dataOnly.length).toBe(1);
});

test("SSR tracking proxy deduplicates call entries for same method", async () => {
  const client = createSSRClient<typeof gpc>(new Api(), {});

  // Call the same method multiple times
  await client.root.posts.count();
  await client.root.posts.count();

  const data = createSerializer().parse(client.generateHydrationData()) as any;
  const callEntries = data.data.filter((d: any) => d.length === 4);
  expect(callEntries.length).toBe(1);
});

test("SSR tracking proxy deduplicates same edge path", async () => {
  const client = createSSRClient<typeof gpc>(new Api(), {});

  // Navigate to posts twice — should only register one ref
  const p1 = client.root.posts;
  const p2 = client.root.posts;

  await p1;
  await p2;

  const data = createSerializer().parse(client.generateHydrationData()) as any;
  expect(data.refs.length).toBe(1);
});

test("SSR tracking proxy records deep traversals", async () => {
  const client = createSSRClient<typeof gpc>(new Api(), {});

  // Navigate: root -> posts -> get("1") -> comments -> get("c1")
  const comment = await client.root.posts.get("1").comments.get("c1");
  expect(comment.id).toBe("c1");
  expect(comment.text).toBe("Great post!");

  const data = createSerializer().parse(client.generateHydrationData()) as any;

  // Should have 4 refs: posts, get("1"), comments, get("c1")
  expect(data.refs.length).toBe(4);
  expect(data.refs[0]).toEqual([0, "posts"]);
  expect(data.refs[1]).toEqual([1, "get", "1"]);
  expect(data.refs[2]).toEqual([2, "comments"]);
  expect(data.refs[3]).toEqual([3, "get", "c1"]);
});

// -- SSR Reference unwrapping tests --

test("SSR: method returning refs exposes data fields", async () => {
  const client = createSSRClient<typeof gpc>(new Api(), {});

  const posts = await client.root.posts.listRefs();
  expect(Array.isArray(posts)).toBe(true);
  expect(posts.length).toBe(2);

  // Data fields on refs should be accessible through the SSR proxy
  expect(posts[0]!.id).toBe("1");
  expect(posts[0]!.title).toBe("Hello World");
  expect(posts[1]!.id).toBe("2");
  expect(posts[1]!.title).toBe("Second Post");
});

test("SSR: edge navigation from refs works", async () => {
  const client = createSSRClient<typeof gpc>(new Api(), {});

  const posts = await client.root.posts.listRefs();
  const first = posts[0]!;

  // Edge traversal through a ref should work (comments is an @edge on Post)
  const comment = await first.comments.get("c1");
  expect(comment.id).toBe("c1");
  expect(comment.text).toBe("Great post!");
});

test("SSR: method call through ref works", async () => {
  const client = createSSRClient<typeof gpc>(new Api(), {});

  const posts = await client.root.posts.listRefs();
  const comment = await posts[0]!.comments.get("c1");

  const upvotes = await comment.upvote();
  expect(upvotes).toBe(42);
});

test("SSR: method returning paths produces navigable stubs", async () => {
  const client = createSSRClient<typeof gpc>(new Api(), {});

  const stubs = await client.root.posts.listPaths();
  expect(stubs.length).toBe(2);

  // Each stub should be navigable — await fetches data
  const post = await stubs[0]!;
  expect(post.id).toBe("1");
  expect(post.title).toBe("Hello World");
});

test("generateHydrationData includes schema", () => {
  const client = createSSRClient<typeof gpc>(new Api(), {});
  const data = createSerializer().parse(client.generateHydrationData()) as any;

  // Schema should be a non-empty array
  expect(Array.isArray(data.schema)).toBe(true);
  expect(data.schema.length).toBeGreaterThan(0);

  // Root type (index 0) should have "posts" edge
  expect(data.schema[0]!.edges).toHaveProperty("posts");
});

// -- getContext() in SSR --

import { getContext } from "./context.ts";

class AuthUser extends Node {
  constructor(public name: string) {
    super();
  }
}

class AuthApi extends Node {
  @edge(AuthUser)
  get me(): AuthUser {
    const ctx = getContext();
    if (!(ctx as any).userId) throw new Error("Unauthorized");
    return new AuthUser((ctx as any).userId);
  }
}

const authGpc = createServer({}, (_ctx: {}) => new AuthApi());

test("SSR: getContext() works inside edge getters", async () => {
  const client = createSSRClient<typeof authGpc>(new AuthApi(), {
    userId: "alice",
  });
  const user = await client.root.me;
  expect(user.name).toBe("alice");
});

test("SSR: getContext() works inside method calls", async () => {
  class CtxMethodApi extends Node {
    @method
    async whoami(): Promise<string> {
      const ctx = getContext();
      return (ctx as any).userId ?? "anonymous";
    }
  }

  const ctxGpc = createServer({}, (_ctx: {}) => new CtxMethodApi());
  const client = createSSRClient<typeof ctxGpc>(new CtxMethodApi(), {
    userId: "bob",
  });
  const name = await client.root.whoami();
  expect(name).toBe("bob");
});

// -- SSR @hidden visibility tests --

import { hidden } from "./decorators.ts";

class AdminPanel extends Node {
  @method
  async secretData(): Promise<string> {
    return "admin-only";
  }
}

class HiddenApi extends Node {
  @edge(PostsService)
  get posts(): PostsService {
    return new PostsService();
  }

  @hidden((ctx: any) => !ctx.isAdmin)
  @edge(AdminPanel)
  get admin(): AdminPanel {
    return new AdminPanel();
  }

  @hidden((ctx: any) => !ctx.isAdmin)
  secretProp = "top-secret";
}

const hiddenGpc = createServer({}, (_ctx: {}) => new HiddenApi());

test("SSR @hidden: hidden own properties excluded from data", async () => {
  const client = createSSRClient<typeof hiddenGpc>(new HiddenApi(), {
    isAdmin: false,
  });
  const data = await client.root;

  // secretProp should be hidden for non-admin (not in data keys)
  expect(Object.keys(data)).not.toContain("secretProp");
});

test("SSR @hidden: hidden own properties included for matching ctx", async () => {
  const client = createSSRClient<typeof hiddenGpc>(new HiddenApi(), {
    isAdmin: true,
  });
  const data = await client.root;

  expect(Object.keys(data)).toContain("secretProp");
  expect(data.secretProp).toBe("top-secret");
});

test("SSR @hidden: hidden edge rejected during SSR traversal", async () => {
  const client = createSSRClient<typeof hiddenGpc>(new HiddenApi(), {
    isAdmin: false,
  });

  try {
    await client.root.admin.secretData();
    expect.unreachable("should have thrown");
  } catch (err: any) {
    expect(err.message).toContain("admin");
  }
});

test("SSR @hidden: visible edge works for matching ctx", async () => {
  const client = createSSRClient<typeof hiddenGpc>(new HiddenApi(), {
    isAdmin: true,
  });

  const result = await client.root.admin.secretData();
  expect(result).toBe("admin-only");
});

// -- Hydration tests (via createClient with hydrationData) --

/** Create a no-op transport that never sends hello (for testing cache-only hydration) */
function noopTransport(): Transport {
  return {
    send() {},
    close() {},
    addEventListener() {},
    removeEventListener() {},
  };
}

test("hydration: data fetch served from cache", async () => {
  const ssrClient = createSSRClient<typeof gpc>(new Api(), {});
  await ssrClient.root.posts.get("1");
  const hydrationData = ssrClient.generateHydrationData();

  const hydrated = createClient<typeof gpc>({}, noopTransport);
  hydrated.hydrateString(hydrationData);

  const result = await hydrated.root.posts.get("1");
  expect(result.id).toBe("1");
  expect(result.title).toBe("Hello World");
});

test("hydration: method call served from cache", async () => {
  const ssrClient = createSSRClient<typeof gpc>(new Api(), {});
  await ssrClient.root.posts.count();
  const hydrationData = ssrClient.generateHydrationData();

  const hydrated = createClient<typeof gpc>({}, noopTransport);
  hydrated.hydrateString(hydrationData);

  const count = await hydrated.root.posts.count();
  expect(count).toBe(2);
});

test("hydration: cache serves multiple requests (entries not consumed)", async () => {
  const ssrClient = createSSRClient<typeof gpc>(new Api(), {});
  await ssrClient.root.posts.get("1");
  const hydrationData = ssrClient.generateHydrationData();

  const hydrated = createClient<typeof gpc>({}, noopTransport);
  hydrated.hydrateString(hydrationData);

  // Same path can be awaited multiple times during hydration
  const r1 = await hydrated.root.posts.get("1");
  const r2 = await hydrated.root.posts.get("1");
  expect(r1.id).toBe("1");
  expect(r2.id).toBe("1");
});

test("hydration: cache miss falls through to transport", async () => {
  const ssrClient = createSSRClient<typeof gpc>(new Api(), {});
  await ssrClient.root.posts.get("1");
  const hydrationData = ssrClient.generateHydrationData();

  // Use a real transport so cache misses can be served
  const [serverTransport, clientTransport] = createMockTransportPair();
  const server = createServer({}, (_ctx: {}) => new Api());
  server.handle(serverTransport, {});

  const hydrated = createClient<typeof gpc>({}, () => clientTransport);
  hydrated.hydrateString(hydrationData);

  // Cached path resolves from cache
  const cached = await hydrated.root.posts.get("1");
  expect(cached.id).toBe("1");

  // Uncached path falls through to transport
  const fresh = await hydrated.root.posts.get("2");
  expect(fresh.id).toBe("2");
  expect(fresh.title).toBe("Second Post");
});

test("hydration: endHydration() drops cache, requests go to transport", async () => {
  const ssrClient = createSSRClient<typeof gpc>(new Api(), {});
  await ssrClient.root.posts.get("1");
  const hydrationData = ssrClient.generateHydrationData();

  const [serverTransport, clientTransport] = createMockTransportPair();
  const server = createServer({}, (_ctx: {}) => new Api());
  server.handle(serverTransport, {});

  const hydrated = createClient<typeof gpc>({}, () => clientTransport);
  hydrated.hydrateString(hydrationData);

  // Cache hit before endHydration
  const cached = await hydrated.root.posts.get("1");
  expect(cached.id).toBe("1");

  hydrated.endHydration();

  // After endHydration, same path goes through transport
  const fresh = await hydrated.root.posts.get("1");
  expect(fresh.id).toBe("1");
  expect(fresh.title).toBe("Hello World");
});

test("hydration: inactivity timeout drops cache", async () => {
  const ssrClient = createSSRClient<typeof gpc>(new Api(), {});
  await ssrClient.root.posts.get("1");
  const hydrationData = ssrClient.generateHydrationData();

  const [serverTransport, clientTransport] = createMockTransportPair();
  const server = createServer({}, (_ctx: {}) => new Api());
  server.handle(serverTransport, {});

  const hydrated = createClient<typeof gpc>(
    { hydrationTimeout: 50 },
    () => clientTransport,
  );
  hydrated.hydrateString(hydrationData);

  // Trigger a cache hit to start the inactivity tracking
  const cached = await hydrated.root.posts.get("1");
  expect(cached.id).toBe("1");

  // Wait for inactivity timeout to fire
  await new Promise((r) => setTimeout(r, 100));

  // After timeout, requests go through transport
  const fresh = await hydrated.root.posts.get("1");
  expect(fresh.id).toBe("1");
  expect(fresh.title).toBe("Hello World");
});

test("hydration: resolves before transport is ready", async () => {
  const ssrClient = createSSRClient<typeof gpc>(new Api(), {});
  await ssrClient.root.posts.get("1");
  await ssrClient.root.posts.count();
  const hydrationData = ssrClient.generateHydrationData();

  // No-op transport — never sends hello, so transport is never "ready"
  const hydrated = createClient<typeof gpc>({}, noopTransport);
  hydrated.hydrateString(hydrationData);

  // Both data and call caches resolve instantly without transport
  const post = await hydrated.root.posts.get("1");
  expect(post.id).toBe("1");

  const count = await hydrated.root.posts.count();
  expect(count).toBe(2);
});

// -- client.hydrate() (pre-parsed data) tests --

test("hydrate: data fetch served from pre-parsed cache", async () => {
  const ssrClient = createSSRClient<typeof gpc>(new Api(), {});
  await ssrClient.root.posts.get("1");
  const hydrationString = ssrClient.generateHydrationData();

  // Simulate browser: JSON.parse produces a plain array (devalue format),
  // then hydrate() uses revive() to unflatten it.
  const preParsed = JSON.parse(hydrationString);

  const hydrated = createClient<typeof gpc>({}, noopTransport);
  hydrated.hydrate(preParsed);

  const result = await hydrated.root.posts.get("1");
  expect(result.id).toBe("1");
  expect(result.title).toBe("Hello World");
});

test("hydrate: method call served from pre-parsed cache", async () => {
  const ssrClient = createSSRClient<typeof gpc>(new Api(), {});
  await ssrClient.root.posts.count();
  const hydrationString = ssrClient.generateHydrationData();

  const preParsed = JSON.parse(hydrationString);

  const hydrated = createClient<typeof gpc>({}, noopTransport);
  hydrated.hydrate(preParsed);

  const count = await hydrated.root.posts.count();
  expect(count).toBe(2);
});

test("hydrate: pre-parsed and string paths produce same results", async () => {
  const ssrClient = createSSRClient<typeof gpc>(new Api(), {});
  await ssrClient.root.posts.get("1");
  await ssrClient.root.posts.count();
  const hydrationString = ssrClient.generateHydrationData();

  // String path
  const stringClient = createClient<typeof gpc>({}, noopTransport);
  stringClient.hydrateString(hydrationString);

  // Pre-parsed path
  const parsedClient = createClient<typeof gpc>({}, noopTransport);
  parsedClient.hydrate(JSON.parse(hydrationString));

  // Both should produce identical results
  const [stringPost, parsedPost] = await Promise.all([
    stringClient.root.posts.get("1"),
    parsedClient.root.posts.get("1"),
  ]);
  expect(parsedPost.id).toBe(stringPost.id);
  expect(parsedPost.title).toBe(stringPost.title);

  const [stringCount, parsedCount] = await Promise.all([
    stringClient.root.posts.count(),
    parsedClient.root.posts.count(),
  ]);
  expect(parsedCount).toBe(stringCount);
});

test("hydrate: cache miss falls through to transport (pre-parsed)", async () => {
  const ssrClient = createSSRClient<typeof gpc>(new Api(), {});
  await ssrClient.root.posts.get("1");
  const hydrationString = ssrClient.generateHydrationData();

  const [serverTransport, clientTransport] = createMockTransportPair();
  const server = createServer({}, (_ctx: {}) => new Api());
  server.handle(serverTransport, {});

  const hydrated = createClient<typeof gpc>({}, () => clientTransport);
  hydrated.hydrate(JSON.parse(hydrationString));

  // Cached path from cache
  const cached = await hydrated.root.posts.get("1");
  expect(cached.id).toBe("1");

  // Uncached path from transport
  const fresh = await hydrated.root.posts.get("2");
  expect(fresh.id).toBe("2");
  expect(fresh.title).toBe("Second Post");
});

// -- Custom serializer SSR hydration tests --

class Money {
  constructor(
    public amount: number,
    public currency: string,
  ) {}
}

class Product extends Node {
  constructor(
    public id: string,
    public name: string,
    private _price: Money,
  ) {
    super();
  }

  @method
  async price(): Promise<Money> {
    return this._price;
  }
}

class ProductService extends Node {
  #products = new Map<string, Product>([
    ["p1", new Product("p1", "Widget", new Money(999, "USD"))],
  ]);

  @edge(Product, z.string())
  get(id: string): Product {
    const p = this.#products.get(id);
    if (!p) throw new Error(`Product ${id} not found`);
    return p;
  }
}

class ShopApi extends Node {
  @edge(ProductService)
  get products(): ProductService {
    return new ProductService();
  }
}

const shopGpc = createServer({}, (_ctx: {}) => new ShopApi());

const moneySerializerOptions = {
  reducers: {
    Money: (v: unknown) => v instanceof Money && [v.amount, v.currency],
  },
  revivers: {
    Money: (v: unknown) => {
      const [amount, currency] = v as [number, string];
      return new Money(amount, currency);
    },
  },
};

test("custom serializer: SSR hydration round-trips custom types", async () => {
  const client = createSSRClient<typeof shopGpc>(
    new ShopApi(),
    {},
    moneySerializerOptions,
  );

  const price = await client.root.products.get("p1").price();
  expect(price).toBeInstanceOf(Money);
  expect(price.amount).toBe(999);
  expect(price.currency).toBe("USD");

  const hydrationData = client.generateHydrationData();

  // Hydrated client with matching serializer options
  const hydrated = createClient<typeof shopGpc>(
    moneySerializerOptions,
    noopTransport,
  );
  hydrated.hydrateString(hydrationData);

  const hydratedPrice = await hydrated.root.products.get("p1").price();
  expect(hydratedPrice).toBeInstanceOf(Money);
  expect(hydratedPrice.amount).toBe(999);
  expect(hydratedPrice.currency).toBe("USD");
});

test("custom serializer: without options, custom types fail to serialize", async () => {
  // SSR client WITHOUT custom serializer — Money won't be reduced.
  // The serde step in backend.resolve() fails immediately (same as the
  // server-side serialization failure in the regular client flow).
  const client = createSSRClient<typeof shopGpc>(new ShopApi(), {});

  try {
    await client.root.products.get("p1").price();
    expect.unreachable("should have thrown");
  } catch {
    // devalue can't stringify arbitrary non-POJOs without a reducer
  }
});

test("custom serializer: full pipeline client vs SSR vs hydrated", async () => {
  // SSR
  const ssrClient = createSSRClient<typeof shopGpc>(
    new ShopApi(),
    {},
    moneySerializerOptions,
  );
  const ssrPrice = await ssrClient.root.products.get("p1").price();

  // Client (via transport)
  const [serverTransport, clientTransport] = createMockTransportPair();
  const server = createServer(
    moneySerializerOptions,
    (_ctx: {}) => new ShopApi(),
  );
  server.handle(serverTransport, {});
  const client = createClient<typeof server>(
    moneySerializerOptions,
    () => clientTransport,
  );
  const clientPrice = await client.root.products.get("p1").price();

  // Hydrated client
  const hydrated = createClient<typeof server>(
    moneySerializerOptions,
    noopTransport,
  );
  hydrated.hydrateString(ssrClient.generateHydrationData());
  const hydratedPrice = await hydrated.root.products.get("p1").price();

  // All three should produce Money instances with correct values
  expect(ssrPrice).toBeInstanceOf(Money);
  expect(clientPrice).toBeInstanceOf(Money);
  expect(hydratedPrice).toBeInstanceOf(Money);

  expect(ssrPrice.amount).toBe(clientPrice.amount);
  expect(ssrPrice.currency).toBe(clientPrice.currency);
  expect(hydratedPrice.amount).toBe(clientPrice.amount);
  expect(hydratedPrice.currency).toBe(clientPrice.currency);
});

// -- Three-way equivalence: client vs SSR vs hydrated client --

function setupClient() {
  const [serverTransport, clientTransport] = createMockTransportPair();
  const server = createServer({}, (_ctx: {}) => new Api());
  server.handle(serverTransport, {});
  return createClient<typeof server>({}, () => clientTransport);
}

test("equivalence: client, SSR, and hydrated client all agree", async () => {
  const client = setupClient();
  const ssrClient = createSSRClient<typeof gpc>(new Api(), {});

  // Perform operations on SSR to collect hydration data
  const ssrPost = await ssrClient.root.posts.get("1");
  const ssrCount = await ssrClient.root.posts.count();
  const ssrComment = await ssrClient.root.posts.get("1").comments.get("c1");

  // Build hydrated client from SSR data
  const [serverTransport, clientTransport] = createMockTransportPair();
  const server = createServer({}, (_ctx: {}) => new Api());
  server.handle(serverTransport, {});
  const hydrated = createClient<typeof gpc>({}, () => clientTransport);
  hydrated.hydrateString(ssrClient.generateHydrationData());

  // Perform same operations on client
  const clientPost = await client.root.posts.get("1");
  const clientCount = await client.root.posts.count();
  const clientComment = await client.root.posts.get("1").comments.get("c1");

  // Perform same operations on hydrated client
  const hydratedPost = await hydrated.root.posts.get("1");
  const hydratedCount = await hydrated.root.posts.count();
  const hydratedComment = await hydrated.root.posts.get("1").comments.get("c1");

  // Data fetch: all three agree
  expect(ssrPost.id).toEqual(clientPost.id);
  expect(ssrPost.title).toEqual(clientPost.title);
  expect(hydratedPost.id).toEqual(clientPost.id);
  expect(hydratedPost.title).toEqual(clientPost.title);

  // Method call: all three agree
  expect(ssrCount).toEqual(clientCount);
  expect(hydratedCount).toEqual(clientCount);

  // Deep traversal: all three agree
  expect(ssrComment.id).toEqual(clientComment.id);
  expect(ssrComment.text).toEqual(clientComment.text);
  expect(hydratedComment.id).toEqual(clientComment.id);
  expect(hydratedComment.text).toEqual(clientComment.text);
});

// -- SSRClient shape tests --

test("SSRClient has RpcClient-compatible shape", () => {
  const client = createSSRClient<typeof gpc>(new Api(), {});

  // Has all RpcClient properties
  expect(client.root).toBeDefined();
  expect(client.ready).toBeInstanceOf(Promise);
  expect(typeof client.on).toBe("function");
  expect(typeof client.off).toBe("function");
  expect(typeof client.hydrate).toBe("function");
  expect(typeof client.hydrateString).toBe("function");
  expect(typeof client.endHydration).toBe("function");
  expect(typeof client.close).toBe("function");

  // Has SSRClient-specific method
  expect(typeof client.generateHydrationData).toBe("function");
});

test("SSRClient ready resolves immediately", async () => {
  const client = createSSRClient<typeof gpc>(new Api(), {});
  await client.ready; // should not hang
});

test("SSRClient is assignable to RpcClient", async () => {
  const ssrClient = createSSRClient<typeof gpc>(new Api(), {});

  // A function that accepts RpcClient should accept SSRClient
  async function useClient(client: RpcClient<typeof gpc>) {
    const post = await client.root.posts.get("1");
    return post.title;
  }

  const title = await useClient(ssrClient);
  expect(title).toBe("Hello World");
});
