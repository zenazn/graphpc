# Changelog

## Unreleased

A correctness, security, and documentation pass over the whole library.

Fixed:

- The `graphpc` entry point no longer crashes on import (type-only symbols were value-exported from the barrel).
- `graphpc` and `graphpc/client` now share one module graph in `dist`, so `instanceof` works across entry points (e.g. in SSR processes that import both).
- Published type declarations resolve under `moduleResolution: node16`/`nodenext` (previously every import from `graphpc` silently degraded to `any`).
- Stream auto-resume rebinds deterministically; a stream opened during the reconnect window can no longer receive another stream's data. `resume()` that throws or fails to open a stream rejects the held `next()` (`RESUME_FAILED`).
- Retry exhaustion rejects held stream `next()` calls and `client.ready` with `ConnectionLostError` instead of hanging; `'disconnect'` fires once per disconnection rather than once per failed attempt.
- Reconnect replay no longer double-executes methods or orphans operations on repeated disconnects; unserializable arguments no longer desync response correlation.
- The server survives malformed and malicious client messages: crafted edge ops, prototype-key lookups, oversized/poisoned tokens, non-serializable returns, and malformed reviver payloads are all rejected cleanly instead of crashing or hanging the connection.
- SSR render passes are deterministic snapshots: each distinct method call executes once, repeated awaits see the recorded result, and `Reference`/`Path` values in node data are navigable proxies (matching the live client).
- `Reference<T>` unwrapping is recursive (containers, nested objects, data properties) at the type level, matching runtime behavior; `arktype` schemas (callable Standard Schemas) are accepted.
- Distinct custom-typed edge arguments get distinct stubs (the stub cache key now formats arguments with the client's reducers).

Added:

- Single-field reads are part of the typed API: `await post.title` typechecks (each data field on a stub is a `PromiseLike` of its value).
- `RpcData<T>` — exported name for the awaited-node / unwrapped-reference shape.
- Subclass redeclarations can change a member's kind (`@edge` → `@method`, etc.); the closest declaration wins.

Versions 0.2 through 0.9.3 shipped without changelog entries; see the git history for that period (notable: stream support with credit-based backpressure and resume, removal of the epoch mechanism in favor of the persistent client cache, and server resource limits).

## 0.1.0

Initial release.

- Type-safe graph API with `Node` classes and `@edge`, `@method`, `@stream`, and `@hidden` decorators
- WebSocket transport with automatic reconnection and exponential backoff
- Server-push streams with credit-based backpressure
- SSR rendering with `createSSRClient` and client-side hydration
- `ref()` for cross-node references in method return values
- Validation via Standard Schema (zod, valibot, arktype, etc.)
- Rich serialization via devalue with custom type support
- ESLint plugin (`graphpc/eslint`) with `require-decorator` rule
