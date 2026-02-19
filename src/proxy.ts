/**
 * Shared proxy builder parameterized by a ProxyBackend.
 *
 * All navigation is synchronous and produces stubs holding a path.
 * At await time, backend.resolve(path) runs. Each backend decides
 * how to resolve (client: send messages or serve hydration cache,
 * SSR: walk real graph).
 */

import { formatPath } from "./format.ts";
import type { PathSegments } from "./path.ts";
import type { Schema } from "./protocol.ts";
import { RpcError } from "./errors.ts";

export const STUB_PATH: unique symbol = Symbol("graphpc.stubPath");

export interface ProxyBackend {
  resolve(path: PathSegments): Promise<unknown>;
}

/**
 * Given a full path and a schema, determine which segments are edges
 * and whether the last segment is a terminal operation (method call
 * or property read).
 *
 * Fully synchronous: walks schema[typeIndex].edges locally.
 * If a segment is in edges, advance the type index.
 * Otherwise it's a terminal operation.
 */
export function classifyPath(
  path: PathSegments,
  schema: Schema,
): {
  edgePath: PathSegments;
  terminal: { name: string; args: unknown[] } | null;
} {
  if (path.length === 0) {
    return { edgePath: [], terminal: null };
  }

  let typeIndex = 0; // root is always index 0

  for (let i = 0; i < path.length; i++) {
    const seg = path[i]!;
    const segName = typeof seg === "string" ? seg : seg[0];
    const segArgs = typeof seg === "string" ? [] : (seg.slice(1) as unknown[]);

    const nodeSchema = schema[typeIndex];
    if (!nodeSchema) {
      if (i + 1 < path.length) {
        throw new RpcError(
          "INVALID_PATH",
          `Invalid path ${formatPath(path)}: "${segName}" at position ${i} is not an edge`,
        );
      }
      return {
        edgePath: path.slice(0, i),
        terminal: { name: segName, args: segArgs },
      };
    }

    const targetIndex = nodeSchema.edges[segName];
    if (targetIndex !== undefined) {
      // Known edge — advance type index
      typeIndex = targetIndex;
      continue;
    }

    // Not an edge — terminal call
    if (i + 1 < path.length) {
      throw new RpcError(
        "INVALID_PATH",
        `Invalid path ${formatPath(path)}: "${segName}" at position ${i} is not an edge`,
      );
    }
    return {
      edgePath: path.slice(0, i),
      terminal: { name: segName, args: segArgs },
    };
  }

  // All segments are edges; no method call
  return { edgePath: path, terminal: null };
}

export function createStub(backend: ProxyBackend, path: PathSegments): any {
  const edgeCache = new Map<string, any>();
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === STUB_PATH) return path;
      if (prop === "then") {
        return (
          onFulfilled?: (v: any) => any,
          onRejected?: (e: any) => any,
        ) => {
          return backend.resolve(path).then(onFulfilled, onRejected);
        };
      }
      if (typeof prop === "symbol") return undefined;
      const propName = String(prop);
      let cached = edgeCache.get(propName);
      if (cached === undefined) {
        cached = createEdgeAccessor(backend, path, propName);
        edgeCache.set(propName, cached);
      }
      return cached;
    },
  };
  return new Proxy({}, handler);
}

export function createEdgeAccessor(
  backend: ProxyBackend,
  parentPath: PathSegments,
  name: string,
): any {
  const getterPath: PathSegments = [...parentPath, name];
  let childStub: any = null;
  function getChild() {
    return (childStub ??= createStub(backend, getterPath));
  }

  function callable(...args: unknown[]) {
    const callPath: PathSegments = [...parentPath, [name, ...args]];
    return createStub(backend, callPath);
  }

  return new Proxy(callable, {
    get(_target, prop) {
      if (prop === STUB_PATH) return getterPath;
      if (prop === "then") return getChild().then;
      return (getChild() as any)[prop];
    },
    apply(_target, _thisArg, args) {
      return callable(...args);
    },
  });
}

export function createDataProxy(
  backend: ProxyBackend,
  path: PathSegments,
  data: Record<string, unknown>,
): any {
  return new Proxy(data, {
    get(target, prop) {
      if (prop === STUB_PATH) return path;
      if (typeof prop === "symbol") return undefined;
      if (prop in target) return target[prop];
      // Prevent infinite thenable loop — resolved data is not a promise
      if (prop === "then") return undefined;
      // Delegate to stub for continued edge navigation
      return (createStub(backend, path) as any)[prop];
    },
  });
}
