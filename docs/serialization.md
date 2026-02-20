# Serialization

## devalue

GraphPC uses [devalue](https://github.com/sveltejs/devalue) for all wire serialization. Devalue handles types that JSON cannot:

- `Date`, `RegExp`, `BigInt`
- `Map`, `Set`
- `undefined` (including as object values)
- Cyclical references
- `NaN`, `Infinity`, `-Infinity`
- Typed arrays

Output is XSS-safe for embedding in HTML `<script>` tags.

## Built-in Type Support

GraphPC automatically registers reducers and revivers for:

- **References** — `ref()` values, serialized as a custom type containing data and path
- **Path references** — `PathArg` and `Path<T>` values, serialized as `NodePath` containing path segments
- **RPC errors** — `RpcError`, `ValidationError`, `EdgeNotFoundError`, `MethodNotFoundError`, `ConnectionLostError`

These survive serialization and deserialization as actual class instances. Built-in names take precedence — if a user-supplied reducer or reviver uses the same name as a built-in, the built-in silently wins.

## Custom Types

Register custom reducers (serialize) and revivers (deserialize) for domain-specific types:

```typescript
import { createServer, createClient, createMockTransportPair } from "graphpc";

class NotFound extends Error {
  constructor(
    public resource: string,
    public id: string,
  ) {
    super(`${resource} ${id} not found`);
  }
}

// Both server and client must register the same custom types
const customTypes = {
  reducers: {
    NotFound: (v: unknown) => v instanceof NotFound && [v.resource, v.id],
  },
  revivers: {
    NotFound: ([resource, id]: [string, string]) => new NotFound(resource, id),
  },
};

const [serverTransport, clientTransport] = createMockTransportPair();

const server = createServer(customTypes, (ctx) => new Api());
server.handle(serverTransport, {});

const client = createClient<typeof server>(customTypes, () => clientTransport);
```

### Reducer Contract

A reducer receives a value and returns either:

- `false` (or any falsy value) — this reducer doesn't handle this value
- An array — the serialized representation (will be passed to the reviver)

### Reviver Contract

A reviver receives the array produced by the reducer and returns the reconstituted instance.

## Error Serialization

Only **thrown** values are serialized into the `error` field of a response. A value that is _returned_ from a method — even if it happens to be an `Error` instance — is treated as normal data: it goes into the `data` field and resolves the client's promise.

| Handler behavior | Wire field | Client behavior               |
| ---------------- | ---------- | ----------------------------- |
| `return value`   | `data`     | Promise resolves with `value` |
| `throw error`    | `error`    | Promise rejects with `error`  |

Thrown values are serialized using the registered reducers — `RpcError` instances, registered custom types, and built-in types all survive the round-trip as actual class instances. Any thrown value that no reducer handles is wrapped in an `RpcError` with a code indicating the operation type (`EDGE_ERROR`, `GET_ERROR`, or `DATA_ERROR`). The error's string representation is preserved as the message, but `instanceof CustomError` will fail on the client, and any structured fields are lost.

Client and server **must** agree on the set of registered custom types. If they disagree (e.g., a reducer exists on the server but no matching reviver on the client), deserialization will fail.

## Human-Readable Formatting

GraphPC provides two functions for producing human-readable strings from paths and values — useful for error messages, debugging, and logging:

```typescript
import { formatPath, formatValue } from "graphpc"; // or "graphpc/client"

formatPath(["posts", ["get", 42]]);
// → 'root.posts.get(42)'

formatValue({ name: "Alice", active: true });
// → '{name: "Alice", active: true}'
```

### `formatPath(path, reducers?)`

Converts a `Path` (array of segments) into a dotted string prefixed with `root`. String segments become `.name` (or `["weird-name"]` for non-identifiers). Call segments become `.method(arg1, arg2)`.

### `formatValue(value, reducers?)`

Formats any value into an unambiguous, human-readable string. Every type produces syntactically distinct output — strings are always quoted, numbers are bare, `null`/`undefined`/`true`/`false`/`NaN`/`Infinity` are keywords, etc.

Supported types: all primitives (including `bigint`, `symbol`, `-0`), `Date`, `RegExp`, `URL`, `URLSearchParams`, `Map`, `Set`, arrays (including sparse), objects (including null-prototype), boxed primitives, typed arrays, `ArrayBuffer`, and circular references (shown as `$N`).

### Custom Reducers

Both functions accept an optional `reducers` parameter — the same interface as devalue's `stringify(value, reducers)`. This lets you format custom types:

```typescript
const reducers = {
  NotFound: (v: unknown) => v instanceof NotFound && [v.resource, v.id],
};

formatValue(new NotFound("User", "123"), reducers);
// → 'NotFound("User", "123")'

formatPath(["users", ["get", "missing"]], reducers);
// → 'root.users.get("missing")'
```

To avoid mismatches, share the same `customTypes` object from a common module imported by both server and client.
