/**
 * Client-only entry point — no Node.js dependencies (no async_hooks).
 * Use "graphpc/client" when bundling for browsers or edge runtimes.
 */

// Reference system (class + type guard only; ref() requires server context)
export { Reference, isReference } from "./reference.ts";

// Path references (PathArg + pathOf for client; Path type-only — no server deps)
export type { Path } from "./node-path.ts";
export { PathArg } from "./path-arg.ts";
export { pathOf } from "./path-of.ts";

// Path utilities
export { type PathSegments, type PathSegment } from "./path.ts";

// Formatting
export { formatPath, formatSegment, formatValue } from "./format.ts";

// Protocol types
export type {
  Transport,
  TransportEventMap,
  ClientMessage,
  ServerMessage,
} from "./protocol.ts";
// Errors
export {
  RpcError,
  ValidationError,
  EdgeNotFoundError,
  MethodNotFoundError,
  PoisonedTokenError,
  ConnectionLostError,
} from "./errors.ts";

// Error UUID
export { getErrorUuid } from "./error-uuid.ts";

// Client
export { createClient } from "./client.ts";

// SSR (types only — createSSRClient is server-only)
export type { SSRClient, HydrationData } from "./ssr.ts";

// Types
export type {
  Timers,
  RpcStub,
  RpcDataOf,
  ClientOptions,
  ReconnectOptions,
  RootOf,
  RpcClient,
  ClientEventMap,
  ClientEvent,
} from "./types.ts";
