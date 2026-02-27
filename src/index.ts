// Decorators
export { edge, method, hidden } from "./decorators";
export type { HiddenPredicate } from "./decorators";

// Reference system
export { Reference, isReference } from "./reference";
export { ref, pathTo } from "./ref";

// Path references
export { Path, path } from "./node-path";
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
export { createMockTransportPair } from "./protocol";

// Test utilities
export { mockConnect } from "./test-utils";

// Errors
export {
  RpcError,
  ValidationError,
  EdgeNotFoundError,
  MethodNotFoundError,
  ConnectionLostError,
} from "./errors";

// Context
export { getContext, abortThisConn, abortSignal } from "./context";

// Error UUID
export { getErrorUuid } from "./error-uuid";

// Hooks
export type { OperationInfo, OperationResult } from "./hooks";

// Server
export { createServer } from "./server";
export type { ServerOptions } from "./server";

// Client
export { createClient } from "./client";

// SSR
export { createSSRClient } from "./ssr";
export type { SSRClient, HydrationData } from "./ssr";

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
} from "./types";
export { Node, nodeTag, canonicalPath, pathTag } from "./types";
