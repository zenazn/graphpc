# Documentation

## Canonical Start Path (Recommended)

1. [Getting Started](getting-started.md) — what GraphPC is, end-to-end walkthrough
2. [Mental Model](mental-model.md) — edges, methods, streams, data fields, path identity
3. [Decorators](decorators.md) — full behavior of `@edge`, `@method`, `@stream`, `@hidden`
4. [Identity and References](identity.md) — `ref()`, `path()`, `pathOf()`, `pathTo()`
5. [Runtime Lifecycle and Resilience](runtime.md) — the lifecycle map: cache, hydration, reconnect
6. [Authentication and Authorization](auth.md) — context + graph reachability model
7. [Common Patterns](patterns.md) — pagination, streams, component integration
8. [Testing](testing.md) — `mockConnect` and transport-pair testing
9. [Glossary](glossary.md) — term reference while reading

## By Task

### Build API Features

1. [Decorators](decorators.md)
2. [Authentication and Authorization](auth.md)
3. [Identity and References](identity.md)
4. [Common Patterns](patterns.md)

### Runtime Behavior

1. [Runtime Lifecycle and Resilience](runtime.md) — start here for the map
2. [Caching and Invalidation](caching.md) — exact coalescing and freshness rules
3. [SSR and Hydration](ssr-and-hydration.md) — server rendering and the hydration window
4. [Reconnection](reconnection.md) — backoff, replay, streams across disconnects

### Operate in Production

1. [Production Guide](production.md) — baseline policy: limits, redaction, timeouts
2. [Production Operations (Advanced)](production-operations.md) — OTel, abort signals, enforcement patterns

### Reference

- [Error Handling](errors.md) — every client-visible error type and failure mode
- [Serialization](serialization.md) — devalue wire encoding and custom types
- [Types and Type Checking](types.md) — `RpcStub` mapping rules and the ESLint plugin
- [Architecture](architecture.md) — system boundaries and tradeoffs in one page
- [Protocol Internals](internals.md) — wire format, tokens, transports, limits
- [LLM Reference](llm.md) — compact, model-friendly cheatsheet
