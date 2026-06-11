import { expect, test } from "bun:test";

// These tests guard the public entry barrels. The rest of the suite imports
// submodules directly, so a broken re-export in index.ts / client-entry.ts
// (e.g. value-exporting a type-only symbol) would otherwise go unnoticed until
// a consumer does `import { ... } from "graphpc"`.

test("graphpc barrel loads and exposes the documented runtime exports", async () => {
  const g = await import("./index");
  for (const name of [
    "createServer",
    "createClient",
    "createSSRClient",
    "Node",
    "edge",
    "method",
    "stream",
    "hidden",
    "ref",
    "pathTo",
    "path",
    "pathOf",
    "canonicalPath",
    "RpcError",
    "ValidationError",
    "RateLimitError",
    "PathDepthExceededError",
    "getContext",
    "abortSignal",
    "createMockTransportPair",
    "mockConnect",
  ]) {
    expect(g[name as keyof typeof g], `missing export: ${name}`).toBeDefined();
  }
});

test("graphpc/client barrel loads and exposes the errors the server can send", async () => {
  const c = await import("./client-entry");
  // Every built-in error a client can receive over the wire must be importable
  // from graphpc/client for documented `instanceof` checks to work in browsers.
  for (const name of [
    "RpcError",
    "ValidationError",
    "EdgeNotFoundError",
    "MethodNotFoundError",
    "ConnectionLostError",
    "TokenExpiredError",
    "StreamLimitExceededError",
    "RateLimitError",
    "PathDepthExceededError",
    "createClient",
    "getErrorUuid",
  ]) {
    expect(c[name as keyof typeof c], `missing export: ${name}`).toBeDefined();
  }
});
