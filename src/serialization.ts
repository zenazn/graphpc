/**
 * Serialization layer using devalue with custom reducers/revivers.
 */

import { stringify, parse, unflatten } from "devalue";
import {
  RpcError,
  ValidationError,
  EdgeNotFoundError,
  MethodNotFoundError,
  ConnectionLostError,
  TokenExpiredError,
  StreamLimitExceededError,
  RateLimitError,
  PathDepthExceededError,
} from "./errors";
import { Reference } from "./reference";
import { PathArg } from "./path-arg";
import type { PathSegments } from "./path";

export interface Serializer {
  stringify(value: unknown): string;
  parse(str: string): unknown;
  revive(flattened: number | unknown[]): unknown;
}

export interface SerializerOptions {
  reducers?: Record<string, (value: unknown) => false | unknown[]>;
  revivers?: Record<string, (value: unknown) => unknown>;
}

// Specific built-in reducers (everything except the RpcError catch-all). These
// are tried BEFORE user reducers so a broad user reducer (e.g. a catch-all
// `v instanceof Error`) cannot steal a built-in type's encoding.
const builtinReducers: Record<string, (value: unknown) => false | unknown[]> = {
  ResolvedRef: (v) => v instanceof Reference && [v.path, v.data],
  ConnectionLostError: (v) => v instanceof ConnectionLostError && [],
  ValidationError: (v) => v instanceof ValidationError && [v.issues],
  EdgeNotFoundError: (v) => v instanceof EdgeNotFoundError && [v.edge],
  MethodNotFoundError: (v) => v instanceof MethodNotFoundError && [v.method],
  TokenExpiredError: (v) => v instanceof TokenExpiredError && [],
  StreamLimitExceededError: (v) => v instanceof StreamLimitExceededError && [],
  RateLimitError: (v) => v instanceof RateLimitError && [],
  PathDepthExceededError: (v) => v instanceof PathDepthExceededError && [],
  NodePath: (v) => v instanceof PathArg && [v.segments],
};

// Catch-all for RpcError and any unregistered subclass, placed LAST in the
// reducer order so the specific built-in reducers above AND user-registered
// custom error reducers (e.g. a CustomRpcError) match first. An unregistered
// subclass round-trips as a base RpcError with its code and message preserved.
const rpcErrorReducer = (v: unknown): false | unknown[] =>
  v instanceof RpcError && [v.code, v.message];

// All names the serializer owns — user reducers using these names are dropped
// (built-ins win) so handles() never claims a value the serializer can't encode.
const builtinReducerNames = new Set([
  ...Object.keys(builtinReducers),
  "RpcError",
]);

/**
 * Shape validation for untrusted payloads. The server parses
 * client-controlled wire data with these revivers; rejecting malformed
 * payloads here keeps blind casts out of the rest of the pipeline.
 */
export function isPathSegments(v: unknown): v is PathSegments {
  if (!Array.isArray(v)) return false;
  for (const seg of v) {
    if (typeof seg === "string") continue;
    if (Array.isArray(seg) && seg.length >= 1 && typeof seg[0] === "string")
      continue;
    return false;
  }
  return true;
}

function isPlainData(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function invalid(name: string): never {
  throw new TypeError(`Invalid ${name} payload`);
}

const builtinRevivers: Record<string, (value: unknown) => unknown> = {
  ResolvedRef: (v) => {
    if (!Array.isArray(v) || !isPathSegments(v[0]) || !isPlainData(v[1]))
      invalid("ResolvedRef");
    return new Reference(v[0], v[1]);
  },
  RpcError: (v) => {
    if (
      !Array.isArray(v) ||
      typeof v[0] !== "string" ||
      typeof v[1] !== "string"
    )
      invalid("RpcError");
    return new RpcError(v[0], v[1]);
  },
  ValidationError: (v) => {
    if (
      !Array.isArray(v) ||
      !Array.isArray(v[0]) ||
      !v[0].every(
        (issue: unknown) =>
          isPlainData(issue) &&
          typeof issue.message === "string" &&
          (issue.path === undefined || Array.isArray(issue.path)),
      )
    )
      invalid("ValidationError");
    return new ValidationError(
      v[0] as { message: string; path?: PropertyKey[] }[],
    );
  },
  EdgeNotFoundError: (v) => {
    if (!Array.isArray(v) || typeof v[0] !== "string")
      invalid("EdgeNotFoundError");
    return new EdgeNotFoundError(v[0]);
  },
  MethodNotFoundError: (v) => {
    if (!Array.isArray(v) || typeof v[0] !== "string")
      invalid("MethodNotFoundError");
    return new MethodNotFoundError(v[0]);
  },
  ConnectionLostError: () => new ConnectionLostError(),
  TokenExpiredError: () => new TokenExpiredError(),
  StreamLimitExceededError: () => new StreamLimitExceededError(),
  RateLimitError: () => new RateLimitError(),
  PathDepthExceededError: () => new PathDepthExceededError(),
  NodePath: (v) => {
    if (!Array.isArray(v) || !isPathSegments(v[0])) invalid("NodePath");
    return new PathArg(v[0]);
  },
};

function buildSerializer(
  reducers: Record<string, (value: unknown) => false | unknown[]>,
  revivers: Record<string, (value: unknown) => unknown>,
) {
  return {
    stringify(value: unknown): string {
      return stringify(value, reducers);
    },
    parse(str: string): unknown {
      return parse(str, revivers);
    },
    revive(flattened: number | unknown[]): unknown {
      return unflatten(flattened, revivers);
    },
  };
}

export function createSerializer(options: SerializerOptions = {}) {
  const userReducers = options.reducers ?? {};
  // Builtin names shadow same-named user reducers at stringify time
  // (documented behavior), so handles() must not consult shadowed reducers —
  // it would claim values the serializer cannot actually encode.
  const effectiveUserReducers = Object.entries(userReducers).filter(
    ([name]) => !builtinReducerNames.has(name),
  );
  // Reducer order (devalue uses the first reducer that returns truthy):
  //   specific built-ins → user reducers → RpcError catch-all.
  // So a broad user reducer can't steal a specific built-in type, yet a
  // user-registered custom RpcError subclass still wins over the catch-all.
  const serializer = buildSerializer(
    {
      ...builtinReducers,
      ...Object.fromEntries(effectiveUserReducers),
      RpcError: rpcErrorReducer,
    },
    { ...options.revivers, ...builtinRevivers },
  );
  return {
    ...serializer,
    handles(value: unknown): boolean {
      for (const [, reducer] of effectiveUserReducers) {
        if (reducer(value)) return true;
      }
      return false;
    },
  };
}

export function createClientSerializer(
  options: SerializerOptions = {},
  resolvedRefReviver: (value: unknown) => unknown,
  nodePathReviver?: (value: unknown) => unknown,
) {
  // Same reducer ordering as createSerializer (see there): specific built-ins
  // → user reducers → RpcError catch-all; builtin-named user reducers dropped.
  const effectiveUserReducers = Object.entries(options.reducers ?? {}).filter(
    ([name]) => !builtinReducerNames.has(name),
  );
  return buildSerializer(
    {
      ...builtinReducers,
      ...Object.fromEntries(effectiveUserReducers),
      RpcError: rpcErrorReducer,
    },
    {
      ...options.revivers,
      ...builtinRevivers,
      ResolvedRef: resolvedRefReviver,
      ...(nodePathReviver && { NodePath: nodePathReviver }),
    },
  );
}
