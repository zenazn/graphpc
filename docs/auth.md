# Authentication and Authorization

GraphPC separates authentication and authorization:

- **Authentication** (verifying identity) starts at context creation time. When a connection is established via `server.handle()`, you extract credentials from cookies, headers, or tokens and populate the context. For fully-authenticated APIs, reject the connection if credentials are invalid. For APIs with public portions, you can choose to defer authentication to the edge that requires it.
- **Authorization** (controlling access) happens during graph traversal. Edge getters and `@hidden` predicates decide what subgraph to expose. The graph topology _is_ the access policy: if a client can reach a node, they're authorized to use it. If they can't reach it, it doesn't exist from their perspective.

## Context as the Authentication Layer

Every connection provides a context via `server.handle()`. This is where credential extraction — and often authentication — happens:

```typescript
const server = createServer({}, (ctx) => new Api());

// Extract credentials from the request, populate context
server.handle(transport, {
  userId: session.userId,
  role: session.role,
});
```

Type the context by augmenting the `Register` interface:

```typescript
// env.d.ts
declare module "graphpc" {
  interface Register {
    context: {
      userId: string | null;
      role: "admin" | "user" | null;
    };
  }
}
```

Use `getContext()` to access the context anywhere during a request — inside edge getters, methods, or any code they call. It uses `AsyncLocalStorage` internally, so it works across async boundaries with no manual threading. It throws if called outside of a request.

### Fully-authenticated APIs

When every part of the API requires authentication, verify credentials at the HTTP upgrade request — before the WebSocket connection is established:

```typescript
const rpc = createServer({}, (ctx) => new Api());

Bun.serve({
  fetch(req, srv) {
    const session = getSessionFromCookies(req);
    if (!session) {
      return new Response("Unauthorized", { status: 401 });
    }
    srv.upgrade(req, {
      data: { userId: session.userId, role: session.role },
    });
  },
  websocket: rpc.wsHandlers<{ userId: string; role: string }>((data) => data),
});
```

Unauthenticated clients get a 401 before a WebSocket is ever opened. Edge getters in this API can trust that the context always contains a valid identity — no need to check credentials during traversal. Every edge getter is purely an authorization boundary.

### Mixed public/authenticated APIs

When an API serves both public and authenticated content, extract and verify credentials at the upgrade request but allow unauthenticated connections through. The context carries optional identity:

```typescript
const rpc = createServer({}, (ctx) => new Api());

Bun.serve({
  fetch(req, srv) {
    const session = getSessionFromCookies(req); // may be null
    srv.upgrade(req, {
      data: {
        userId: session?.userId ?? null,
        role: session?.role ?? null,
      },
    });
  },
  websocket: rpc.wsHandlers<{ userId: string | null; role: string | null }>(
    (data) => data,
  ),
});
```

Authentication is deferred to the edge that requires it — the `me` edge checks whether identity is present in the context and throws if not (see [Public vs Authenticated Subgraphs](#public-vs-authenticated-subgraphs) below).

## Context Lifetime

The same context object is shared across every request on a connection — it's stable for the connection's lifetime. Do not mutate it mid-connection: the schema was already built using the original values, edge getters that already ran with the original context are cached and will not re-execute, and the server does not expect it to change. If a user's session or role changes, revoke the connection instead (see [Session revocation](#session-revocation) below).

## The Capability Model

Authorization in GraphPC follows a capability model. Holding a reference to an object grants you permission to use it. The graph topology is the authorization policy:

- **If you can reach it, you can use it.** A `Post` node doesn't need to check "is the caller allowed to see this post?" — the edge that returned it already made that decision.
- **Revocation is structural.** Remove the edge (throw from the getter), and the entire subtree becomes unreachable.
- **Scoping is implicit.** `AuthenticatedUser` returns a different user's data for each session. The rest of the tree doesn't know or care.

## Edge Getters as Authorization Boundaries

Edge getters control what parts of the graph a client can reach. The context (populated at connection time) carries the caller's identity; edge getters use it to make authorization decisions:

```typescript
class Api extends Node {
  @edge(AuthenticatedUser)
  get me(): AuthenticatedUser {
    const ctx = getContext();
    if (!ctx.userId) throw new Unauthorized();
    return new AuthenticatedUser(ctx.userId);
  }
}
```

The client navigates through `me` to reach anything that requires a logged-in user:

```typescript
const profile = await client.root.me;
const drafts = await client.root.me.drafts.list();
```

If the context has no identity, the edge throws — nothing beneath it is reachable. Child nodes don't need their own checks because reachability itself implies authorization.

In a fully-authenticated API (where the connection was already verified), `ctx.userId` is always present and this edge never throws. In a mixed API, this edge is the authentication boundary for the authenticated subgraph.

## Public vs Authenticated Subgraphs

When an API serves both public and authenticated content, the context carries optional identity. Public edges don't check it; authenticated edges do:

```typescript
class Api extends Node {
  @edge(PublicPostsService)
  get posts(): PublicPostsService {
    return new PublicPostsService(); // no identity required
  }

  @edge(AuthenticatedUser)
  get me(): AuthenticatedUser {
    const ctx = getContext();
    if (!ctx.userId) throw new Unauthorized();
    return new AuthenticatedUser(ctx.userId);
  }
}
```

Public edges are freely traversable. The `me` edge checks the context for identity — this is where authentication happens for the authenticated subgraph. Credentials were already extracted at context creation; the edge just checks whether they're present.

## Role-Based Authorization

Different users can see different graphs. Edge getters read the context to make authorization decisions based on role:

```typescript
class Api extends Node {
  @edge(AdminPanel)
  get admin(): AdminPanel {
    const ctx = getContext();
    if (ctx.role !== "admin") throw new Forbidden();
    return new AdminPanel();
  }

  @edge(Dashboard)
  get dashboard(): Dashboard {
    const ctx = getContext();
    return new Dashboard(ctx.userId);
  }
}
```

The `admin` edge performs an authorization check — only users with the `"admin"` role can proceed. A regular user is denied at the edge, and the admin subtree doesn't exist from their perspective.

This composes: an `AdminPanel` can itself have edges that scope further (e.g., `admin.orgSettings` only visible to org admins).

## Hiding Edges with `@hidden`

The throw-from-edge approach above works for authorization but still exposes the edge name in the schema — a non-admin client can see that `admin` exists, even though they can't traverse it. `@hidden` removes the edge from the schema entirely:

```typescript
class Api extends Node {
  @hidden((ctx) => ctx.role !== "admin")
  @edge(AdminPanel)
  get admin(): AdminPanel {
    return new AdminPanel();
  }

  @edge(Dashboard)
  get dashboard(): Dashboard {
    const ctx = getContext();
    return new Dashboard(ctx.userId);
  }
}
```

For a non-admin, the `admin` edge doesn't appear in the schema at all — it's as if `AdminPanel` and everything beneath it were never declared.

Use `@hidden` when the existence of an edge is itself sensitive information. Use throw-from-edge when the schema can be public and you just want to gate authorization at runtime.

### Dual evaluation

`@hidden` predicates are evaluated at two points:

1. **At connection open** — the server evaluates every `@hidden` predicate to determine which edges appear in the schema sent in the hello message. Hidden edges (and any types only reachable through them) are omitted entirely.

2. **On every access attempt** — the server re-evaluates the `@hidden` predicate before processing each request. Even if a client somehow attempts to traverse a hidden edge (e.g., by crafting raw protocol messages), the server rejects it with the same error as a nonexistent edge or method.

This makes `@hidden` a defense-in-depth mechanism, not just a schema filter. The schema omission prevents accidental discovery; the access-time check prevents exploitation.

### Path references and `@hidden`

When a client sends a `Path<T>` argument (see [Path References](paths.md)), the `path()` schema validates it against the connection's schema — which excludes `@hidden` edges. A path like `root.secret.get("1")` where `secret` is hidden will be rejected before any graph walk happens. When the `Path<T>` is later awaited, it walks the real graph through `resolveEdge`, which re-checks `@hidden` at each step — the same defense-in-depth.

## Read-Only vs Writable Surfaces

A common pattern: a resource that's read-only for most users but writable by one (e.g., the author). Rather than sprinkling permission checks across every mutation method, split the resource into two nodes — a read-only surface that everyone can reach, and a writable surface behind an authorizing edge.

```typescript
class Post extends Node {
  id: string;
  title: string;
  body: string;
  authorId: string;

  constructor(id: string) {
    super();
    const row = db.posts.get(id);
    this.id = row.id;
    this.title = row.title;
    this.body = row.body;
    this.authorId = row.authorId;
  }

  @edge(WritablePost)
  get writable(): WritablePost {
    const ctx = getContext();
    if (ctx.userId !== this.authorId) throw new Forbidden();
    return new WritablePost(this.id);
  }
}

class WritablePost extends Node {
  #id: string;
  constructor(id: string) {
    super();
    this.#id = id;
  }

  @method(z.string())
  async updateTitle(title: string): Promise<void> {
    await db.posts.update(this.#id, { title });
  }

  @method(z.string())
  async updateBody(body: string): Promise<void> {
    await db.posts.update(this.#id, { body });
  }

  @method
  async delete(): Promise<void> {
    await db.posts.delete(this.#id);
  }
}
```

Any user can read a post's data — `title`, `body`, `authorId` are all on the read-only `Post` node. But only the author can traverse the `.writable` edge to reach mutation methods:

```typescript
// Anyone can read
const { title, body } = await client.root.posts.get("1");

// Only the author can write
const writable = await client.root.posts.get("1").writable;
await writable.updateTitle("New Title");
```

This follows the capability model: the `.writable` edge is the authorization boundary, and `WritablePost` is the capability. If you hold a reference to it, you've already been authorized. The mutation methods don't need their own checks.

## Edge Getter Caching and Authorization Safety

Edge getters run **once per path** within an epoch. When the server resolves a path like `root.users.get("42")`, it caches the resulting node instance for the duration of the connection. Subsequent requests to the same path reuse the cached instance — the getter doesn't run again.

This is safe because:

1. **Context is stable per connection** — the authorization decision only needs to run once, since the context (and therefore the user's identity and permissions) won't change mid-connection.
2. **Each epoch has its own node cache** — nodes are never shared across connections or epochs. Two users resolving the same path get separate node instances, each authorized independently by their connection's edge getter. When a connection closes and a new epoch begins, the cache starts empty and edge getters run again.

```typescript
class Api extends Node {
  @edge(AuthenticatedUser)
  get me(): AuthenticatedUser {
    const ctx = getContext();
    if (!ctx.userId) throw new Unauthorized();
    // This runs once per connection — subsequent traversals reuse the cached node
    return new AuthenticatedUser(ctx.userId);
  }
}
```

There's no cross-user leakage. Connection A's cached `AuthenticatedUser("u1")` is invisible to connection B, which has its own cache and its own `AuthenticatedUser("u2")`.

## Impersonation

Because identity is just an edge returning a scoped subgraph, impersonation ("act as another user") is straightforward. An admin edge can return someone else's `AuthenticatedUser`:

```typescript
class AdminPanel extends Node {
  @edge(AuthenticatedUser, z.string())
  impersonate(userId: string): AuthenticatedUser {
    return new AuthenticatedUser(userId);
  }
}
```

The impersonated subgraph is identical to what the real user sees — same edges, same methods, same permissions — because it's literally the same `AuthenticatedUser` object. No special "sudo mode" flag, no permission overrides scattered through the codebase. The admin simply enters the graph at a different point.

This is easy to audit: impersonation is only reachable through the `admin` edge, which already gates on `role === "admin"`. Add logging in the `impersonate` edge and you have a complete audit trail.

## Session Revocation

`abortThisConn()` immediately closes the transport for the current connection. Like `getContext()`, it uses `AsyncLocalStorage` internally and can be called from anywhere during a request.

```typescript
import { getContext, abortThisConn } from "graphpc";

class Api extends Node {
  @method
  async performAction(): Promise<void> {
    const ctx = getContext();

    // Check if the session has been revoked
    const revoked = await db.revokedSessions.has(ctx.userId);
    if (revoked) {
      abortThisConn(); // closes the transport immediately
      return;
    }

    // ... normal logic
  }
}
```

It throws if called outside of a request.

If the client has `reconnect` enabled, it will auto-reconnect after the transport closes. The server's WebSocket handler runs again for the new connection, giving you the chance to reject it or provide an updated context.

## Reconnection as Context Refresh

When a client reconnects (whether after `abortThisConn()`, a network drop, or a server restart), a new epoch begins — the new connection starts completely fresh:

- The transport factory runs again (new WebSocket handshake)
- `server.handle()` is called with a new context (credentials re-extracted)
- A new schema is built (re-evaluating all `@hidden` predicates)
- A new, empty node cache is created

This means reconnection is the mechanism for context refresh. If a session is invalidated or a user's role changes, abort the connection; the reconnecting client gets a new context reflecting their updated identity and permissions.

For reconnection configuration and behavior details, see [Reconnection & Connection Resilience](reconnection.md).
