# Architecture

When to read this page: after [Mental Model](mental-model.md), when you want system boundaries and key tradeoffs in one place.

This page describes GraphPC's system boundaries and tradeoffs.

For core semantics (`@edge`, `@method`, `await node`), start with [Getting Started](getting-started.md) and [Mental Model](mental-model.md).

## System Boundary

GraphPC provides:

- graph-shaped RPC semantics (`@edge`, `@method`, data fields)
- typed client stubs inferred from server types
- request/response protocol over WebSocket transport
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

This keeps graph traversal cheap while making network boundaries explicit.

## Identity and Cache Boundary

Node identity is path-based (`root.posts.get("42")`).

Caching is scoped to an epoch (a contiguous activity window on one connection):

- same node/property reads can coalesce and hit cache
- method calls do not coalesce
- cache is dropped when the epoch ends

Design implication: treat epoch caches as connection-scoped performance hints, not durable state.

## Concurrency Boundary

GraphPC executes operations concurrently on the server.

- No automatic per-node serialization for method calls
- No exactly-once mutation guarantee under reconnect
- Caller-side sequencing (`await`) is the primary ordering tool

Design implication: if operation order or deduplication matters, enforce it in application logic (sequential awaits, idempotency keys, transactional guarantees).

## Transport Boundary

GraphPC currently uses WebSockets, but the interaction model is request/response:

- no built-in server push/subscription protocol
- reconnect starts a fresh epoch (fresh schema/context/cache)
- pending operations can replay depending on reconnect behavior

Design implication: model GraphPC as resilient RPC, not as a streaming event bus.

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

Tradeoffs:

- requires discipline for mutation ordering/idempotency
- less suited to subscription-first workloads
- path/epoch model adds concepts teams need to learn
