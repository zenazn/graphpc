# SSR and Hydration

## Overview

GraphPC supports server-side rendering (SSR). During SSR, components interact with real objects — no network, no WebSocket. GraphPC records which edges were traversed and which data was fetched, then serializes everything into the HTML for client-side hydration.

The SSR client implements the same `RpcClient` interface as the regular client, so components can be written once and used in both environments.

## Server-Side Rendering

### Creating an SSR Client

```typescript
import { createSSRClient } from "graphpc";

const api = new Api();
const client = createSSRClient<typeof server>(api, ctx);
```

The `ctx` is the connection context (same type you'd pass to `server.handle()`). It controls which `@hidden` edges are visible — the SSR schema respects the same visibility rules as a live WebSocket connection.

An optional third argument accepts `SerializerOptions` (custom reducers/revivers) — pass the same options here as you pass to `createServer` and `createClient` so that custom types serialize correctly in the hydration payload.

The returned `client` is an `SSRClient` — it extends `RpcClient` with a `generateHydrationData()` method. Components use `client.root` exactly like they would with a regular client.

### Using the Client

Components interact with the SSR client the same way they interact with a regular client:

```typescript
// In your server-side component rendering
const users = client.root.users;
const user = users.get("42");
const { name, email } = await user; // Fetches data, records it
const posts = await user.posts.list(); // Calls method, records result
```

The client delegates to the real objects — all data is live and correct. The recording is transparent.

### Generating Hydration Data

After rendering, call `client.generateHydrationData()` to get a string containing a valid JavaScript expression:

```html
<script>
  window.__rpc = ${client.generateHydrationData()}
</script>
```

This function uses [devalue](https://github.com/sveltejs/devalue)'s `stringify`, which produces a JSON array that is both valid JS (safe to embed in a `<script>` tag) and XSS-safe (all `<` characters are escaped).

## Client-Side Hydration

### Hydrating the Client

Create the client, then call `.hydrate()` with the pre-parsed value from the `<script>` tag:

```typescript
import { createClient } from "graphpc/client";

const client = createClient<typeof server>({}, () => connectTransport());
client.hydrate(window.__rpc);
```

If you have hydration data as a raw string (e.g. from `fetch` or `localStorage`), use `.hydrateString()` instead:

```typescript
const client = createClient<typeof server>({}, () => connectTransport());
client.hydrateString(rawString);
```

Either method must be called synchronously after `createClient` — before any `await`s on the client.

The client serves cached data instantly — before the WebSocket is even connected. Components hydrate **without any network calls**, seeing the same data they saw during SSR.

### Hydration Lifetime

The entire hydration cache survives until hydration is **done**. Cache entries are **not** consumed on first access — each entry can serve multiple requests during hydration. In epoch terms, this is the **hydration epoch** — a special epoch whose cache is pre-populated from the SSR payload rather than from wire responses (see [Epochs & Caching](caching.md#the-hydration-epoch)).

The hydration epoch ends when either:

1. **`client.endHydration()`** is called explicitly, or
2. An **inactivity timeout** fires (default 250ms, configurable via `hydrationTimeout`)

Inactivity tracking:

- The client is "active" while any cache hit is being consumed (within the microtask)
- When in-flight count drops to 0, the inactivity timeout starts
- If a new cache hit arrives during the timeout, the timer resets
- When the timeout fires, all caches are dropped

```typescript
// Explicit end
client.endHydration();

// Or configure a custom timeout (default 250ms)
const client = createClient<typeof server>({ hydrationTimeout: 500 }, () =>
  connectTransport(),
);
client.hydrate(window.__rpc);
```

After the hydration epoch ends, all cached data is dropped. The next request triggers a WebSocket connection, starting the first live epoch. All subsequent requests go through the transport normally.

### Lifecycle

```
SSR
  1. createSSRClient<typeof server>(api, ctx) → SSR client (RpcClient-compatible)
  2. Components render using client.root
  3. Embed client.generateHydrationData() in HTML

Hydration (hydration epoch)
  4. createClient(opts, transportFactory) → client
  5. client.hydrate(window.__rpc)  (or client.hydrateString(str))
  6. Components re-render using client.root + cached data (instant, no network)
  7. Cache entries reusable during the hydration epoch

Transition (hydration epoch ends)
  8. endHydration() called or inactivity timeout fires
  9. Hydration epoch ends — caches dropped, client becomes a normal transport-backed client
     If the transport is not yet connected, requests are queued until it is.
     See docs/reconnection.md.

Live (live epochs — one per WebSocket connection)
  10. User interactions → requests go over the wire
      Each WebSocket connection is a live epoch with its own cache
```

For how the client caches data after hydration ends, see [Epochs & Caching](caching.md).

## What Gets Tracked

The SSR client records:

- **Edge traversals**: property accesses and method calls on `@edge` members
- **Data fetches**: `await` on a node proxy (records the node's public properties)
- **Method calls**: calls to `@method` members (records the arguments and return value)

Plain property access (non-edge, non-method) is not recorded — it delegates directly to the real object.

### Method Call Replay During Hydration

Method call recording is what makes the hydration epoch different from a live epoch. During SSR, each `@method` call's arguments and return value are captured and embedded in the hydration payload. On the client, when a component calls the same method with the same arguments during the hydration epoch, the cached result is returned immediately — no network round-trip occurs.

```typescript
// SSR — recorded: path=posts.list, args=[], result=[{title:"Hello World"}]
const posts = await client.root.posts.list();

// Client hydration — same call returns the cached result instantly
const posts = await client.root.posts.list(); // no WebSocket needed
```

This is unique to the hydration epoch. In live epochs, `@method` results are never cached — every call goes over the wire.

## Unified Component Pattern

Because `SSRClient` extends `RpcClient`, components can be typed to accept `RpcClient` and work in both SSR and client environments:

```typescript
import type { RpcClient } from "graphpc";

function PostView({ client }: { client: RpcClient<typeof server> }) {
  const post = await client.root.posts.get("42");
  return <div>{post.title}</div>;
}
```

This component works identically whether `client` is:

- An `SSRClient` from `createSSRClient()` (server-side)
- An `RpcClient` from `createClient()` (client-side, with or without hydration)

## Integration with Frameworks

### The General Pattern

Every framework integration follows the same steps, mapped to GraphPC primitives:

| Step        | What happens                                               | GraphPC primitive                   |
| ----------- | ---------------------------------------------------------- | ----------------------------------- |
| **Render**  | Server renders components using SSR client                 | `createSSRClient()` → `client.root` |
| **Embed**   | Serialize hydration data into HTML                         | `client.generateHydrationData()`    |
| **Hydrate** | Client reads embedded data instead of making network calls | `createClient()` then `.hydrate()`  |

### What a Framework Adapter Needs to Do

1. **Create an SSR client** before rendering. This requires a real API root instance and a connection context (same type passed to `server.handle`).
2. **Pass the client to components** (or just `client.root`). Components use `client.root` the same way they would with a regular client. The SSR client records all traversals and data fetches transparently.
3. **Call `client.generateHydrationData()`** after rendering completes. This must happen after all async data fetches have resolved. Embed the resulting payload in the HTML response.
4. **Initialize the client with hydration data** on the client side. The client serves cached data instantly, then transitions to the live transport.

### Conceptual React/Next.js Example

> This is a conceptual example showing how the primitives compose. GraphPC does not ship a React adapter — you'd build one using these primitives.

**Server (inside a request handler):**

```typescript
import { createSSRClient } from "graphpc";

async function renderPage(req: Request): Promise<string> {
  const session = await getSession(req);
  const api = new Api();
  const ctx = { userId: session.userId, isAdmin: session.isAdmin };

  const client = createSSRClient<typeof server>(api, ctx);

  // Components use `client.root` to traverse the graph during render.
  const html = await renderToString(<App client={client} />);

  const hydrationScript = `<script>
    window.__rpc = ${client.generateHydrationData()};
  </script>`;

  return `<!DOCTYPE html>
    <html><body>
      <div id="root">${html}</div>
      ${hydrationScript}
      <script type="module" src="/client.js"></script>
    </body></html>`;
}
```

**Client:**

```typescript
import { createClient } from "graphpc/client";

const client = createClient<typeof server>(
  {},
  () => new WebSocket("ws://localhost:3000"),
);
client.hydrate(window.__rpc); // hydration data from SSR

// Components hydrate instantly from cache, then transition to live transport.
hydrateRoot(document.getElementById("root")!, <App client={client} />);
```

**Component (works in both environments):**

```typescript
import type { RpcClient } from "graphpc";

function App({ client }: { client: RpcClient<typeof server> }) {
  const post = await client.root.posts.get("42");
  return <div>{post.title}</div>;
}
```

### Framework-Specific Considerations

**React Server Components (RSC):** Server Components can use the SSR client directly since they run on the server. Client Components receive serialized data. The boundary between server and client aligns naturally with GraphPC's SSR → hydration transition.

**Streaming SSR:** If your framework streams HTML (e.g., `renderToPipeableStream`), you need all data fetches to resolve before calling `client.generateHydrationData()`. The hydration script must appear in the HTML _after_ the components that depend on it. Consider using Suspense boundaries to control when data resolves.

**Suspense:** Components that `await` on `client.root` during SSR block their Suspense boundary. This is the same behavior as any async data source. The proxy is synchronous for edge traversals and async for data fetches — Suspense boundaries should wrap the data-fetching parts.

### Current Status

No official framework adapters exist yet. The SSR primitives (`createSSRClient`, `client.generateHydrationData()`, `createClient` + `.hydrate()`) are stable and framework-agnostic. Building an adapter for your framework means wiring these primitives into your framework's server-rendering and hydration lifecycle.
