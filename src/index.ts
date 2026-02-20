// Decorators
export { edge, method, hidden } from "./decorators.ts";
export type { HiddenPredicate } from "./decorators.ts";

// Reference system
export { Reference, isReference } from "./reference.ts";
export { ref, pathTo } from "./ref.ts";

// Path references
export { Path, path } from "./node-path.ts";
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
export { createMockTransportPair } from "./protocol.ts";

// Test utilities
export { mockConnect } from "./test-utils.ts";

// Errors
export {
  RpcError,
  ValidationError,
  EdgeNotFoundError,
  MethodNotFoundError,
  ConnectionLostError,
} from "./errors.ts";

// Context
export { getContext, abortThisConn, abortSignal } from "./context.ts";

// Error UUID
export { getErrorUuid } from "./error-uuid.ts";

// Hooks
export type { OperationInfo, OperationResult } from "./hooks.ts";

// Server
export { createServer } from "./server.ts";
export type { ServerOptions } from "./server.ts";

// Client
export { createClient } from "./client.ts";

// SSR
export { createSSRClient } from "./ssr.ts";
export type { SSRClient, HydrationData } from "./ssr.ts";

// Types
export type {
  Timers,
  RpcStub,
  RpcDataOf,
  ClientOptions,
  ReconnectOptions,
  ServerInstance,
  WebSocketHandlers,
  WsLike,
  RootOf,
  Register,
  Context,
  CanonicalArgs,
  RpcClient,
  ClientEventMap,
  ClientEvent,
  OperationErrorInfo,
  ServerEventMap,
  ServerEvent,
} from "./types.ts";
export { Node, nodeTag, canonicalPath, pathTag } from "./types.ts";
