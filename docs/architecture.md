# Architecture

When to read this page: after [Mental Model](mental-model.md), when you want system boundaries and key tradeoffs in one place.

This page describes GraphPC's system boundaries and tradeoffs.

For core semantics (`@edge`, `@method`, `@stream`, `await node`), start with [Getting Started](getting-started.md) and [Mental Model](mental-model.md).

## System Boundary

GraphPC provides:

- graph-shaped RPC semantics (`@edge`, `@method`, `@stream`, data fields)
- typed client stubs inferred from server types
- request/response and server-push protocol over WebSocket transport
- per-connection schema filtering (`@hidden`) and context-aware execution

Your application provides:

- domain modeling and persistence
- authentication strategy
- authorization decisions in edge/method logic
- operational policy (timeouts, limits, observability)

## Runtime Boundary

At runtime, GraphPC separates **navigation** from **execution**:

- Navigation (`@edge`) is local path construction on the client.
- Execution (`await node`, `await node.field`, `node.method()`) is remote RPC.
- Streams (`@stream`) are server-push data feeds over the same connection.

This keeps graph traversal cheap while making network boundaries explicit.

## Identity and Cache Boundary

Node identity is path-based (`root.posts.get("42")`).

Caching is persistent — the client cache survives reconnects:

- same node/property reads can coalesce and hit cache
- method calls do not coalesce
- freshness is managed via `invalidate()`, `evict()`, and `ref()` returns
- referential identity is preserved across reconnects

Design implication: the persistent cache provides stable references for UI frameworks, while `invalidate()` and `evict()` give explicit control over freshness.

## Concurrency Boundary

GraphPC executes operations concurrently on the server.

- No automatic per-node serialization for method calls
- No exactly-once mutation guarantee under reconnect
- Caller-side sequencing (`await`) is the primary ordering tool

Design implication: if operation order or deduplication matters, enforce it in application logic (sequential awaits, idempotency keys, transactional guarantees).

## Transport Boundary

GraphPC uses WebSockets with both request/response and server-push capabilities:

- request/response for edges, methods, and data reads
- server-push via `@stream` for async generators with credit-based backpressure
- reconnect preserves the persistent cache and replays in-flight operations
- pending operations can replay depending on reconnect behavior

Design implication: model GraphPC as resilient RPC with server-push streaming for real-time data feeds.

## Authorization Boundary

Authorization is structural by default: graph reachability defines what a client can do.

- edge getters are capability boundaries
- `@hidden` controls per-connection schema visibility
- context is established at connection time and expected to remain stable per connection

Design implication: put high-level access checks at graph boundaries (edge entry points), not scattered across every downstream method.

## Tradeoffs

Strengths:

- ergonomic typed graph navigation
- explicit execution semantics
- strong SSR/hydration and reconnection story
- clean fit for capability-style authorization
- server-push streams for real-time data feeds

Tradeoffs:

- requires discipline for mutation ordering/idempotency
- path model adds concepts teams need to learn
