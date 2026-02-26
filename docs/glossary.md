# Glossary

When to read this page: alongside any other doc page when you need fast term disambiguation.

Use this page as a quick vocabulary reference while reading the docs.

## Core Terms

### Node

A server-side class that extends `Node` from `graphpc`. Nodes are the units of graph structure and behavior.

### Edge (`@edge`)

A navigable relationship from one node to another node. Edge navigation on the client is local path construction (no immediate network call).

### Method (`@method`)

A callable operation on a node that returns data over RPC. When client code calls a `@method`, GraphPC always sends a request to the server to execute it there.

See also: [Decorators](decorators.md), [Mental Model](mental-model.md)

### Data fields

A node's public properties and getters, including inherited ones. Loaded together by `await node`.

See also: [Mental Model](mental-model.md), [Decorators](decorators.md)

### Stub (`RpcStub<T>`)

The typed client-side proxy for a node. Stubs mirror server graph shape and support navigation, data reads, and method calls.

## Identity and Path Terms

### Path

The sequence of edge/property/method-call segments used to reach a node (for example: `root.posts.get("42")`).

See also: [Mental Model](mental-model.md), [Path References](identity.md)

### Canonical path

A class-defined path (via `[canonicalPath]`) used as the stable identity route for `ref()` and `pathTo()`.

See also: [Identity and References](identity.md), [Path References](identity.md)

### PathArg

Client-side wire wrapper for path segments, typically created by `pathOf(stub)`.

See also: [Path References](identity.md)

### Path<T>

Server-side thenable path reference. `await` resolves it to a live node after validation and graph walking.

See also: [Path References](identity.md)

## Freshness and Lifecycle Terms

### Epoch

A connection-scoped activity window with its own cache and token space. Caches are dropped when an epoch ends.

See also: [Epochs and Caching](caching.md), [Runtime Lifecycle and Resilience](runtime.md)

### Hydration epoch

A short-lived epoch seeded from SSR hydration payload rather than wire responses.

See also: [SSR and Hydration](ssr-and-hydration.md), [Epochs and Caching](caching.md)

### Coalescing

Combining duplicate in-flight reads (same node/property) into one wire request within an epoch.

See also: [Epochs and Caching](caching.md)

### Reference (`Reference<T>`, `ref()`)

A method-returnable value containing canonical path + data, so the client receives a navigable object with data already loaded.

See also: [Identity and References](identity.md)

## Security and Context Terms

### Context

Per-connection request context supplied to `server.handle(...)` (or transport helpers) and accessed with `getContext()`.

See also: [Authentication and Authorization](auth.md)

### `@hidden`

Decorator that conditionally removes members from a connection's schema and enforces hidden access checks at runtime.

See also: [Decorators](decorators.md), [Authentication and Authorization](auth.md), [Error Handling](errors.md)

### Capability model

Authorization model where reachability defines permissions: if a client can reach a node, it can use that node's exposed surface.

See also: [Authentication and Authorization](auth.md)
