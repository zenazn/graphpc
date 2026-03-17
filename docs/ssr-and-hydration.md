# SSR and Hydration

When to read this page: once basic traversal/method semantics are clear and you're integrating server rendering.

## Overview

GraphPC supports server-side rendering (SSR). During SSR, components interact with real objects — no network, no WebSocket. GraphPC records which edges were traversed and which data was fetched, then serializes everything into the HTML for client-side hydration.

The SSR client implements the same `RpcClient` interface as the regular client, so components can be written once and used in both environments.

Streams (`@stream` members) are inert during SSR — they are not available on the SSR client.

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

This function uses [devalue](https://github.com/sveltejs/devalue)'s `stringify`, which produces output that is safe to embed in a `<script>` tag (for example, `<` characters are escaped).

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

Either method must be called synchronously after `createClient` and before any client `await`s.

The client serves cached data instantly, before the WebSocket is even connected. Components hydrate **without network calls**, seeing the same data they saw during SSR.

### Hydration Lifetime

Hydration runs as a special phase. During this window, reads are served from the SSR payload cache instead of the wire. Cache entries are reusable during the hydration phase.

The hydration phase ends when either:

1. **`client.endHydration()`** is called explicitly, or
2. An **inactivity timeout** fires (default 250ms, configurable via `hydrationTimeout`)

```typescript
// Explicit end
client.endHydration();

// Or configure a custom timeout (default 250ms)
const client = createClient<typeof server>({ hydrationTimeout: 500 }, () =>
  connectTransport(),
);
client.hydrate(window.__rpc);
```

When hydration ends:

- **Method call results** recorded during SSR are dropped from the cache. Methods are not cached during live operation, so keeping SSR-recorded results would be incorrect.
- **All other data** (edge traversals, node data, property reads) stays in the persistent cache and continues to serve reads.
- The next cache miss that requires live data opens a WebSocket connection.

For exact cache and timeout behavior, see [Caching and Invalidation](caching.md#hydration).

For the end-to-end runtime timeline (SSR -> hydration -> persistent cache -> reconnect), see [Runtime Lifecycle and Resilience](runtime.md).

## What Gets Tracked

The SSR client records:

- **Edge traversals**: property accesses and method calls on `@edge` members
- **Data fetches**: `await` on a node proxy (records the node's public properties)
- **Method calls**: calls to `@method` members (records the arguments and return value)

Plain property access (non-edge, non-method) is not recorded — it delegates directly to the real object.

Streams (`@stream` members) are not tracked during SSR and are not included in the hydration payload.

### Method Call Replay During Hydration

During SSR, each `@method` call's arguments and return value are captured in the hydration payload. During the hydration phase, the same call (same path + args) is replayed from cache instead of the network.

```typescript
// SSR — recorded: path=posts.list, args=[], result=[{title:"Hello World"}]
const posts = await client.root.posts.list();

// Client hydration — same call returns the cached result instantly
const posts = await client.root.posts.list(); // no WebSocket needed
```

This behavior is unique to the hydration phase. During live operation, `@method` results are never cached. When hydration ends, SSR-recorded method results are dropped from the cache.

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

| Step        | What happens                                               | GraphPC primitive                    |
| ----------- | ---------------------------------------------------------- | ------------------------------------ |
| **Render**  | Server renders components using SSR client                 | `createSSRClient()` -> `client.root` |
| **Embed**   | Serialize hydration data into HTML                         | `client.generateHydrationData()`     |
| **Hydrate** | Client reads embedded data instead of making network calls | `createClient()` then `.hydrate()`   |

### What a Framework Adapter Needs to Do

1. **Create an SSR client** before rendering. This requires a real API root instance and a connection context (same type passed to `server.handle`).
2. **Pass the client to components** (or just `client.root`). Components use `client.root` the same way they would with a regular client. The SSR client records all traversals and data fetches transparently.
3. **Call `client.generateHydrationData()`** after rendering completes. This must happen after all async data fetches have resolved. Embed the resulting payload in the HTML response.
4. **Initialize the client with hydration data** on the client side. The client serves cached data instantly, then transitions to the live transport.

### Minimal Adapter Sketch

```typescript
// Server request path
const ssrClient = createSSRClient<typeof server>(new Api(), ctx);
const html = await renderApp({ client: ssrClient }); // framework render function
const hydration = ssrClient.generateHydrationData();
// Embed hydration into HTML as window.__rpc

// Client boot path
const client = createClient<typeof server>({}, transportFactory);
client.hydrate(window.__rpc);
hydrateApp({ client }); // framework hydrate function
```

### Integration Notes

- Generate hydration data only after SSR data fetches complete.
- Ensure hydration payload script is emitted before client code reads `window.__rpc`.
- Call `hydrate()`/`hydrateString()` before client-side awaits.
- Streams are not available during SSR — they require a live WebSocket connection.
- Treat framework boundaries (RSC/Suspense/streaming) as framework concerns; GraphPC integration stays the same: `createSSRClient` -> `generateHydrationData` -> `createClient` + `hydrate`.
