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

const builtinReducers: Record<string, (value: unknown) => false | unknown[]> = {
  ResolvedRef: (v) => v instanceof Reference && [v.path, v.data],
  RpcError: (v) =>
    v instanceof RpcError && v.constructor === RpcError && [v.code, v.message],
  ConnectionLostError: (v) => v instanceof ConnectionLostError && [],
  ValidationError: (v) => v instanceof ValidationError && [v.issues],
  EdgeNotFoundError: (v) => v instanceof EdgeNotFoundError && [v.edge],
  MethodNotFoundError: (v) => v instanceof MethodNotFoundError && [v.method],
  TokenExpiredError: (v) => v instanceof TokenExpiredError && [],
  StreamLimitExceededError: (v) => v instanceof StreamLimitExceededError && [],
  NodePath: (v) => v instanceof PathArg && [v.segments],
};

const builtinRevivers: Record<string, (value: unknown) => unknown> = {
  ResolvedRef: (v) => {
    const [path, data] = v as [PathSegments, Record<string, unknown>];
    return new Reference(path, data);
  },
  RpcError: (v) => {
    const [code, message] = v as [string, string];
    return new RpcError(code, message);
  },
  ValidationError: (v) => {
    const [issues] = v as [{ message: string; path?: PropertyKey[] }[]];
    return new ValidationError(issues);
  },
  EdgeNotFoundError: (v) => {
    const [edge] = v as [string];
    return new EdgeNotFoundError(edge);
  },
  MethodNotFoundError: (v) => {
    const [method] = v as [string];
    return new MethodNotFoundError(method);
  },
  ConnectionLostError: () => new ConnectionLostError(),
  TokenExpiredError: () => new TokenExpiredError(),
  StreamLimitExceededError: () => new StreamLimitExceededError(),
  NodePath: (v) => {
    const [segments] = v as [PathSegments];
    return new PathArg(segments);
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
  const serializer = buildSerializer(
    { ...userReducers, ...builtinReducers },
    { ...options.revivers, ...builtinRevivers },
  );
  return {
    ...serializer,
    handles(value: unknown): boolean {
      for (const key in userReducers) {
        if (userReducers[key]!(value)) return true;
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
  return buildSerializer(
    { ...options.reducers, ...builtinReducers },
    {
      ...options.revivers,
      ...builtinRevivers,
      ResolvedRef: resolvedRefReviver,
      ...(nodePathReviver && { NodePath: nodePathReviver }),
    },
  );
}
