/**
 * Client-only entry point — no Node.js dependencies (no async_hooks).
 * Use "graphpc/client" when bundling for browsers or edge runtimes.
 */

// Reference system (class + type guard only; ref() requires server context)
export { Reference, isReference } from "./reference";

// Path references (PathArg + pathOf for client; Path type-only — no server deps)
export type { Path } from "./node-path";
export { PathArg } from "./path-arg";
export { pathOf } from "./path-of";

// Path utilities
export { type PathSegments, type PathSegment } from "./path";

// Formatting
export { formatPath, formatSegment, formatValue } from "./format";

// Protocol types
export type {
  Transport,
  TransportEventMap,
  ClientMessage,
  ServerMessage,
} from "./protocol";
// Errors
export {
  RpcError,
  ValidationError,
  EdgeNotFoundError,
  MethodNotFoundError,
  ConnectionLostError,
  TokenExpiredError,
  StreamLimitExceededError,
} from "./errors";

// Error UUID
export { getErrorUuid } from "./error-uuid";

// Client
export { createClient, invalidate, evict, subscribe } from "./client";

// SSR (types only — createSSRClient is server-only)
export type { SSRClient, HydrationData } from "./ssr";

// Types
export type {
  Timers,
  RpcStub,
  RpcStream,
  RpcDataOf,
  ClientOptions,
  ReconnectOptions,
  RootOf,
  RpcClient,
  ClientEventMap,
  ClientEvent,
} from "./types";
