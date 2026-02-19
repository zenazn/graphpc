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
  PoisonedTokenError,
} from "./errors.ts";
import { Reference } from "./reference.ts";
import { PathArg } from "./path-arg.ts";
import type { PathSegments } from "./path.ts";

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
  PoisonedTokenError: (v) =>
    v instanceof PoisonedTokenError && [v.token, v.originalError],
  NodePath: (v) => v instanceof PathArg && [v.segments],
};

const builtinRevivers: Record<string, (value: any) => unknown> = {
  ResolvedRef: ([path, data]: [PathSegments, Record<string, unknown>]) =>
    new Reference(path, data),
  RpcError: ([code, message]: [string, string]) => new RpcError(code, message),
  ValidationError: ([issues]: [any[]]) => new ValidationError(issues),
  EdgeNotFoundError: ([edge]: [string]) => new EdgeNotFoundError(edge),
  MethodNotFoundError: ([method]: [string]) => new MethodNotFoundError(method),
  ConnectionLostError: () => new ConnectionLostError(),
  PoisonedTokenError: ([token, originalError]: [number, unknown]) =>
    new PoisonedTokenError(token, originalError),
  NodePath: ([segments]: [PathSegments]) => new PathArg(segments),
};

function buildSerializer(
  reducers: Record<string, (value: unknown) => false | unknown[]>,
  revivers: Record<string, (value: any) => unknown>,
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
