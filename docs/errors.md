# Error Handling

When to read this page: when you want exact client-visible error types and `instanceof` behavior.

## Built-in Error Types

GraphPC provides error classes that all extend `RpcError`:

| Error                      | Code                    | When it occurs                                                            |
| -------------------------- | ----------------------- | ------------------------------------------------------------------------- |
| `RpcError`                 | varies                  | Base class for all RPC errors; also wraps non-registered thrown values    |
| `ValidationError`          | `VALIDATION_ERROR`      | `@edge` or `@method` argument fails schema validation                     |
| `EdgeNotFoundError`        | `EDGE_NOT_FOUND`        | Server handled an `edge` op for a missing or hidden edge                  |
| `MethodNotFoundError`      | `METHOD_NOT_FOUND`      | Server handled a `get` op for a missing or hidden member                  |
| `ConnectionLostError`      | `CONNECTION_LOST`       | All reconnect attempts exhausted                                          |
| `TokenExpiredError`        | `TOKEN_EXPIRED`         | Auto-replay circuit breaker tripped (5 consecutive failures on same path) |
| `StreamLimitExceededError` | `STREAM_LIMIT_EXCEEDED` | Too many concurrent streams on this connection                            |

When a token expires, the client automatically replays the path to obtain a fresh token — this is transparent to application code. `TokenExpiredError` only surfaces to the caller if the auto-replay circuit breaker trips (after 5 consecutive replay failures on the same path). See [Internals — Token Window](internals.md#token-window).

When the stream limit is exceeded, the server returns a `StreamLimitExceededError` for the new stream request. Existing streams are unaffected.

All built-in errors are automatically serialized and deserialized — the client receives actual class instances with `instanceof` support.

## Custom Error Types

Register reducers and revivers to preserve custom error types across the wire:

```typescript
import { createServer } from "graphpc";
import { createClient } from "graphpc/client";

class InsufficientFunds extends Error {
  constructor(
    public required: number,
    public available: number,
  ) {
    super(`Need ${required}, have ${available}`);
  }
}

const customTypes = {
  reducers: {
    InsufficientFunds: (v: unknown) =>
      v instanceof InsufficientFunds && [v.required, v.available],
  },
  revivers: {
    InsufficientFunds: ([req, avail]: [number, number]) =>
      new InsufficientFunds(req, avail),
  },
};

const server = createServer(customTypes, (ctx) => new Api());
const client = createClient<typeof server>(customTypes, () => transport);
// Use client.root.* for graph navigation
```

**What if a custom error type isn't registered?** The error is wrapped in a generic `RpcError` before serialization. The `message` is preserved, but `instanceof InsufficientFunds` will fail on the client and structured fields (`required`, `available`) are lost. Always register custom types on both sides — and keep them in sync, since a mismatch causes deserialization to fail. In production, unregistered errors are also subject to [Error Redaction](#error-redaction).

See [Serialization](serialization.md) for the full reducer/reviver contract.

## What the Client Receives

Here's what the client receives for every failure mode:

| Failure                                     | Client receives                                                                                                   | `instanceof`               |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `@edge`/`@method` argument fails validation | `ValidationError` with `.issues`                                                                                  | `ValidationError`          |
| Edge throws a registered custom error       | The custom error instance                                                                                         | Custom class               |
| Edge throws a non-registered custom error   | `RpcError` (message preserved)                                                                                    | `RpcError` only            |
| Edge throws any other value                 | `RpcError` with code `EDGE_ERROR`                                                                                 | `RpcError`                 |
| Method throws a registered custom error     | The custom error instance                                                                                         | Custom class               |
| Method throws a non-registered custom error | `RpcError` (message preserved)                                                                                    | `RpcError` only            |
| Method throws any other value               | `RpcError` with code `GET_ERROR`                                                                                  | `RpcError`                 |
| Data op throws any other value              | `RpcError` with code `DATA_ERROR`                                                                                 | `RpcError`                 |
| `@hidden` edge via forced `edge` op         | `EdgeNotFoundError`                                                                                               | `EdgeNotFoundError`        |
| `@hidden` edge via normal proxy access      | Usually `MethodNotFoundError` (can be `RpcError` `INVALID_PATH` for deeper paths, e.g. `root.admin.secretData()`) | Varies                     |
| `@hidden` method accessed                   | `MethodNotFoundError`                                                                                             | `MethodNotFoundError`      |
| Operation on failed edge's token            | Original error (propagated)                                                                                       | Varies                     |
| All reconnect attempts fail                 | `ConnectionLostError`                                                                                             | `ConnectionLostError`      |
| Token replay circuit breaker tripped        | `TokenExpiredError`                                                                                               | `TokenExpiredError`        |
| Too many concurrent streams                 | `StreamLimitExceededError`                                                                                        | `StreamLimitExceededError` |

### Hidden-member nuance

Hidden-member errors are operation-dependent:

- If the server receives an `edge` op for a hidden edge, it returns `EdgeNotFoundError`.
- If the server receives a `get` op for a hidden member, it returns `MethodNotFoundError`.

In normal client proxy usage, hidden edges are absent from the schema, so access is often classified as `get` and surfaces as `MethodNotFoundError`. For deeper paths, classification can fail earlier with `RpcError` (`INVALID_PATH`). A raw/probing client can still force an `edge` op and receive `EdgeNotFoundError`.

## Error Redaction

Redaction is an operational concern configured on the server (`redactErrors`) and documented in [Production Guide — Error Redaction](production.md#error-redaction).

Quick rule: built-in errors, registered custom errors, and directly thrown `RpcError` are not redacted; other thrown values can be redacted in production.

## Error UUIDs (`getErrorUuid`)

Every error response includes a server-assigned UUID. Retrieve it on the client with `getErrorUuid()`:

```typescript
import { getErrorUuid } from "graphpc/client";

try {
  await client.root.posts.get("42");
} catch (err) {
  const uuid = getErrorUuid(err);
  // uuid correlates with the server's operationError event
}
```

Use `server.on("operationError", ...)` to log the same UUID server-side. Full logging/correlation guidance: [Production Guide — Error Reporting](production.md#error-reporting).
