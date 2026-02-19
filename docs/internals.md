# Protocol Internals

> This document is for project contributors and protocol implementors. If you're using GraphPC to build an API, you don't need this — see [Architecture](architecture.md) instead.

## Connection Setup

When a connection opens, the server sends a **hello message** (message 0) — a server-initiated message containing the protocol version and an indexed array of node types. Each entry maps edge names to the index of their target type. Index 0 is always the root:

```json
{
  "op": "hello",
  "version": 1,
  "schema": [
    { "edges": { "posts": 1, "users": 2 } },
    { "edges": { "get": 3 } },
    { "edges": { "get": 4 } },
    { "edges": { "comments": 5 } },
    { "edges": {} },
    { "edges": {} }
  ]
}
```

The `version` field is the protocol version (currently `1`). The client uses the schema to distinguish edges from non-edges: if a name appears in `edges`, it's an edge traversal; otherwise it's a terminal `get` request (method call, property read, or getter invocation). The schema only contains edges — everything else is identified by exclusion.

## Wire Format

### Client → Server

**Edge traversal** — navigate from a node to a child:

```json
{ "op": "edge", "tok": 0, "edge": "posts" }
{ "op": "edge", "tok": 1, "edge": "get", "args": ["42"] }
```

**Get request** — read a property, invoke a getter, or call a `@method` on a node:

```json
{ "op": "get", "tok": 2, "name": "updateTitle", "args": ["New Title"] }
{ "op": "get", "tok": 0, "name": "count" }
{ "op": "get", "tok": 0, "name": "version" }
```

**Data request** — get a node's data fields:

```json
{ "op": "data", "tok": 2 }
```

### Server → Client

Every response carries a `re` ("in reply to") field referencing the implicit ID of the client message being answered (see [Message Identity](#message-identity)). The `hello` message is message 0 — server-initiated with no `re`.

**Edge result** — confirms traversal succeeded:

```json
{ "op": "edge", "tok": 1, "re": 1 }
```

On failure, the result carries an error and an `errorId` (UUID for correlation):

```json
{ "op": "edge", "tok": 2, "re": 2, "error": { ... }, "errorId": "550e8400-..." }
```

**Get result** — returns data or error:

```json
{ "op": "get", "tok": 2, "re": 3, "data": "Hello World" }
```

**Data result** — returns node properties or error:

```json
{
  "op": "data",
  "tok": 2,
  "re": 4,
  "data": { "title": "Hello World", "body": "..." }
}
```

### The `get` Op

The `get` op handles three kinds of access through a single message. The client doesn't distinguish between them — it just sends a name (and optional args). The server resolves the name against the node:

1. **`@method` invocation** — If the name matches a `@method`-decorated function, args are validated against the method's schemas and the function is called. This is the only case where args are accepted.

2. **Property read** — If the name matches an own data property on the node instance (and no args are provided), the value is returned directly. If the value is a function, the request is rejected with an error.

3. **Getter invocation** — If the name matches a getter defined on the node's prototype chain (stopping before `Object.prototype`), the getter is called and the result is returned. If the result is a function, the request is rejected with an error.

The `data` op returns all data fields — own properties and getter results, excluding `@edge`, `@method`, and `@hidden` members. The `get` op is used for `@method` calls and individual field reads when the full node data has not yet been fetched.

The server applies security checks in order:

- `constructor`, `__proto__`, and `prototype` are always blocked
- `@hidden` members are rejected
- `@edge` members are rejected (must use the `edge` op)
- Only `@method`-decorated functions can be called with arguments
- Undecorated functions are never returned or called

### Client-Side Path Representation

On the client, navigation builds a **path** — an array of segments. Property access appends a string (e.g., `"title"`), while a function call appends an array (e.g., `["get", "42"]` or `["method"]` for zero-arg calls). This distinction determines caching behavior for terminal operations: a string terminal (property read like `await node.title`) is cached within an epoch, while an array terminal (method call like `node.update("x")`) is never cached. Edge traversals — whether string or array segments — are always cached. See [Epochs & Caching](caching.md).

## Token Machine

Tokens are sequential integers assigned to nodes within a session:

- Token `0` is always the root (assigned implicitly on connection open)
- Each edge traversal assigns the next token: `1`, `2`, `3`, ...
- Both client and server track the counter independently
- The client knows what token a traversal will produce before the response arrives

### Token Lifecycle

```
Connection opens       → token 0 = root
edge(0, "posts")       → token 1 = PostsService
edge(1, "get", ["42"]) → token 2 = Post
edge(0, "users")       → token 3 = UsersService
```

Tokens are ephemeral — scoped to a single epoch. When the connection closes (ending the epoch), all token state is garbage collected.

## Message Identity

Every message has an implicit sequential number assigned by its position in the transport stream. Client messages are numbered 1, 2, 3… (positive). Server messages are numbered -1, -2, -3… (negative). These numbers are never carried as fields on the wire — they exist only as counters on each side.

The only place a message number appears explicitly is the `re` field on server responses, which references the client message being answered.

## Request-Response Correlation

Server responses carry `re: number` ("in reply to") on the wire, matching the implicit number of the client message that triggered the response. The `hello` message is message 0 — server-initiated (no `re`).

Responses may arrive out of order for `get` and `data` operations. The client matches each response to its pending request by `re`, not by arrival order.

```
→ get(0, "slowMethod")           // implicit ID 3
→ get(0, "fastMethod")           // implicit ID 4
← get result (re=4, data=...)    // fast resolves first
← get result (re=3, data=...)    // slow resolves second
```

Responses may also arrive out of order for `edge` operations. The server processes edges with dependency ordering — a child edge waits for its parent token to resolve — but sibling edges (same parent) run in parallel and may complete in any order. The client matches all responses by `re`, not by arrival order.

## Node Coalescing

For a given path, a node must be created exactly once per connection. The server coalesces concurrent resolutions of the same path — if two operations race to resolve the same node, the first resolution wins and subsequent operations receive the same instance.

This guarantees:

- **Stable object identity** — same path → same object reference within a connection
- **Exactly-once side effects** — edge resolution side effects execute only once per path
- **Correct concurrent behavior** — concurrent `get`/`data` handlers that trigger `ref()` with overlapping paths coalesce safely

## Pipelining

Because tokens are sequential and predictable, the client can **pipeline** — send multiple messages without waiting for responses:

```
→ edge(0, "posts")              // will be token 1, implicit ID 1
→ edge(1, "get", ["42"])        // will be token 2, implicit ID 2
→ data(2)                       // fetch data for token 2, implicit ID 3
← edge result (tok=1, re=1)
← edge result (tok=2, re=2)
← data result (tok=2, re=3, data={...})
```

The client sends all three messages immediately. The server processes them with dependency ordering: each operation waits for the token it references to be resolved. A child edge (token 1 → token 2) waits for its parent (token 0 → token 1) to complete. Sibling edges from the same parent run in parallel. `get` and `data` operations wait for their target token, then run concurrently. Responses may arrive out of order.

## Concurrency & Ordering

### No ordering guarantee for `get` and `data`

`get` (method calls and property reads) and `data` (full-node loads) ops execute concurrently on the server with **no ordering guarantee** — even when they target the same node. If the client sends two mutations on the same node without awaiting either, they may execute and complete in any order:

```
→ get(2, "updateTitle", ["A"])   // implicit message ID 4
→ get(2, "updateTitle", ["B"])   // implicit message ID 5
← get result (re=5)              // "B" may finish first; re = "in reply to" message 5
← get result (re=4)              // "A" may finish second — title is now "A"
```

The library does not queue or order ops per-node. There's no built-in concurrency control — concurrent access to the same node instance is the developer's responsibility.

### Edges use dependency ordering

Edge traversals are processed with dependency ordering: a child edge waits for its parent token to resolve before starting. Sibling edges (from the same parent) run in parallel. Tokens are always assigned sequentially (matching the client's prediction), but edge resolution is concurrent where possible.

### `await` enforces client-side ordering

Awaiting a `get` op guarantees the server has finished executing it before the client sends the next request. Sequential `await` calls therefore produce sequential execution:

```typescript
// Safe — sequential execution guaranteed
await post.updateTitle("A"); // server completes before next line runs
await post.updateTitle("B"); // title is now "B", guaranteed
```

```typescript
// Unsafe — execution order is non-deterministic
const p1 = post.updateTitle("A"); // sent immediately
const p2 = post.updateTitle("B"); // sent immediately, may execute before p1
await Promise.all([p1, p2]); // title could be "A" or "B"
```

Fire-and-forget calls (not awaiting) pipeline onto the wire and may execute in any order. This is safe for independent reads but dangerous for mutations that must be ordered:

```
// Fire-and-forget reads — safe, order doesn't matter
const p1 = post.title;
const p2 = post.author;
const [title, author] = await Promise.all([p1, p2]);

// Fire-and-forget mutations — unsafe, order is non-deterministic
post.updateTitle("Draft");
post.publish();  // may execute before updateTitle
```

## Failure Semantics

### Poisoned Tokens

Edge traversals **always consume a token**, even on failure. A failed token is **poisoned** — any subsequent operation targeting it immediately returns the original error:

```
→ edge(1, "get", ["deleted-user"])           // implicit ID 3
← edge result (tok=2, re=3, error: NotFound)

→ get(2, "updateEmail", ["x"])               // implicit ID 4
← get result (tok=2, re=4, error: NotFound)  // same error, not executed
```

This keeps client and server token counters in sync, which is critical for pipelining. Without this rule, a failed traversal would desynchronize the counters and break all subsequent messages.

### Error Types

Errors are serialized through devalue with custom reducers, so the client receives actual error instances:

- `ValidationError` — schema validation failed
- `EdgeNotFoundError` — referenced edge doesn't exist
- `MethodNotFoundError` — referenced method/property doesn't exist
- `PoisonedTokenError` — operation on a poisoned token
- `ConnectionLostError` — all reconnection attempts exhausted
- `RpcError` — base class for all RPC errors

## Abort Signal Tree

Each connection has a **connection-wide** `AbortController`. Each incoming message creates a **per-operation** `AbortController`. The signals are combined via `AbortSignal.any([connSignal, opSignal])` and stored on the session.

```
Connection AbortController ─────────┐
                                     ├─ AbortSignal.any() → session.signal
Per-operation AbortController ───────┘
```

- The connection-wide signal fires when the transport closes.
- The per-operation signal fires when `maxOperationTimeout` expires.
- User code calls `abortSignal()` to get the combined signal.

## Transport Interface

The protocol is transport-agnostic. Any object satisfying this interface works:

```typescript
interface Transport {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "message",
    listener: (event: { data: string }) => void,
  ): void;
  addEventListener(type: "close", listener: (event: {}) => void): void;
  addEventListener(type: "error", listener: (event: {}) => void): void;
  removeEventListener(type: string, listener: Function): void;
}
```

This matches the Web `WebSocket` API, so you can pass a `WebSocket` directly to `server.handle()` or `createClient()`.

### Web / Node.js `ws`

Both the standard Web `WebSocket` and the `ws` npm package structurally satisfy `Transport`. Pass them directly:

```typescript
// Client (browser or Node.js)
const client = createClient<typeof server>(
  {},
  () => new WebSocket("ws://localhost:3000"),
);

// Node.js ws server
import { WebSocketServer } from "ws";
const wss = new WebSocketServer({ port: 3000 });
wss.on("connection", (ws) => server.handle(ws, ctx));
```

### Bun server-side

Bun's `Bun.serve()` uses a handler-based WebSocket API (lifecycle callbacks instead of an event emitter). Use `server.wsHandlers()`:

```typescript
Bun.serve({
  fetch(req, srv) {
    srv.upgrade(req, { data: { userId: "..." } });
  },
  websocket: server.wsHandlers<{ userId: string }>((data) => data),
});
```

### Testing

For testing, use `mockConnect(server, ctx)` which creates a connected mock transport pair and returns the client-side transport:

```typescript
import { mockConnect } from "graphpc";
const client = createClient<typeof server>({}, () => mockConnect(server, ctx));
```

For advanced tests that need to spy on raw wire messages, use `createMockTransportPair()` directly.

## Idle Timeout

The server can be configured with an `idleTimeout` (default: 5000ms). After no pending operations and no new messages for the timeout duration, the server closes the connection and garbage collects all token state.

```typescript
const server = createServer({ idleTimeout: 10_000 }, (ctx) => new Api()); // 10 seconds
```

## Max Tokens

The server can be configured with a `maxTokens` limit to bound per-connection memory usage. When the total number of tokens (both active and poisoned) reaches the limit, the next edge traversal returns an `RpcError` with code `TOKEN_LIMIT_EXCEEDED` and the connection is closed.

```typescript
const server = createServer({ maxTokens: 1000 }, (ctx) => new Api());
```

This prevents a single long-lived connection from accumulating unbounded token state. Each edge traversal allocates state that persists for the lifetime of the connection. Without a limit, a client navigating thousands of edges would keep all of those objects in memory indefinitely.

When the limit is exceeded:

1. The server assigns a token (to keep client/server counters synchronized for pipelined messages)
2. The token is poisoned with an `RpcError` (code `TOKEN_LIMIT_EXCEEDED`)
3. The error response is sent to the client
4. The connection is closed

## Max Pending Ops

The server limits the number of concurrently executing operations per connection via `maxPendingOps` (default: 20). This bounds how many operations are running user code (edge resolution, method calls, data collection) at the same time. Token resolution (`waitFor`) does not count against this limit — only the actual resolve/execute phase does.

```typescript
const server = createServer({ maxPendingOps: 50 }, (ctx) => new Api());
```

When all slots are occupied, new operations wait for a slot to free up after completing token resolution. This provides natural backpressure: the server processes work at a bounded rate, and the client's pending promises resolve as capacity becomes available. The `maxTokens` limit bounds edge traversals specifically — `maxPendingOps` bounds all operation types (`edge`, `get`, and `data`).

Operations waiting for a slot are processed in FIFO order as slots free up.

## Max Queued Ops

`maxQueuedOps` (default: 1000) bounds the total number of in-flight messages per connection — messages that have been received but not yet responded to. If a new message arrives and the count exceeds the limit, the connection is closed immediately.

```typescript
const server = createServer({ maxQueuedOps: 500 }, (ctx) => new Api());
```

This protects the server from misbehaving clients that send messages far faster than they can be processed. Each in-flight message holds a parsed message object and a promise chain. Without a bound, a flooding client could cause unbounded memory growth.

## Max Operation Timeout

`maxOperationTimeout` (default: 30,000ms, 0 = disabled) sets a per-operation time limit. When the timeout fires, the server sends an `OPERATION_TIMEOUT` error to the client and aborts the operation's abort signal. The handler continues running in the background (does not release its concurrency slot until it finishes).

```typescript
const server = createServer(
  { maxOperationTimeout: 10_000 },
  (ctx) => new Api(),
);
```

For edge operations, the token is poisoned on timeout, so pipelined operations that depend on it fail immediately. See [Production Guide — Operation Timeout](production.md#operation-timeout).
