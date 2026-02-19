# Error Handling

## Built-in Error Types

GraphPC provides error classes that all extend `RpcError`:

| Error                 | Code               | When it occurs                                                         |
| --------------------- | ------------------ | ---------------------------------------------------------------------- |
| `RpcError`            | varies             | Base class for all RPC errors; also wraps non-registered thrown values |
| `ValidationError`     | `VALIDATION_ERROR` | `@edge` or `@method` argument fails schema validation                  |
| `EdgeNotFoundError`   | `EDGE_NOT_FOUND`   | Edge doesn't exist or is `@hidden` from this connection                |
| `MethodNotFoundError` | `METHOD_NOT_FOUND` | Method/property doesn't exist or is `@hidden`                          |
| `PoisonedTokenError`  | `POISONED_TOKEN`   | Attempt to use a token for an edge that previously failed              |
| `ConnectionLostError` | `CONNECTION_LOST`  | All reconnect attempts exhausted                                       |

When `maxTokens` is exceeded, the server returns an `RpcError` with code `TOKEN_LIMIT_EXCEEDED` and closes the connection. See [Internals — Max Tokens](internals.md#max-tokens).

All built-in errors are automatically serialized and deserialized — the client receives actual class instances with `instanceof` support.

## Custom Error Types

Register reducers and revivers to preserve custom error types across the wire:

```typescript
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

| Failure                                     | Client receives                        | `instanceof`          |
| ------------------------------------------- | -------------------------------------- | --------------------- |
| `@edge`/`@method` argument fails validation | `ValidationError` with `.issues`       | `ValidationError`     |
| Edge throws a registered custom error       | The custom error instance              | Custom class          |
| Edge throws a non-registered custom error   | `RpcError` (message preserved)         | `RpcError` only       |
| Edge throws any other value                 | `RpcError` with code `EDGE_ERROR`      | `RpcError`            |
| Method throws a registered custom error     | The custom error instance              | Custom class          |
| Method throws a non-registered custom error | `RpcError` (message preserved)         | `RpcError` only       |
| Method throws any other value               | `RpcError` with code `GET_ERROR`       | `RpcError`            |
| Data op throws any other value              | `RpcError` with code `DATA_ERROR`      | `RpcError`            |
| `@hidden` edge accessed                     | `EdgeNotFoundError`                    | `EdgeNotFoundError`   |
| `@hidden` method accessed                   | `MethodNotFoundError`                  | `MethodNotFoundError` |
| Operation on failed edge's token            | `PoisonedTokenError` wrapping original | `PoisonedTokenError`  |
| All reconnect attempts fail                 | `ConnectionLostError`                  | `ConnectionLostError` |

## Error Redaction

In production, unregistered errors are redacted to prevent leaking internal details. The message is replaced with `"Internal server error"` while the error code is preserved. Built-in errors, custom registered types, and directly thrown `RpcError` instances are never redacted.

```typescript
const server = createServer(
  { redactErrors: true }, // auto-detected from NODE_ENV=production
  (ctx) => new Api(),
);
```

See [Production Guide — Error Redaction](production.md#error-redaction) for details.

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

Use `server.on("operationError", ...)` to log errors with their UUIDs. See [Production Guide — Error Reporting](production.md#error-reporting).
