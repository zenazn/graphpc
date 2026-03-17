/**
 * Shared proxy builder parameterized by a ProxyBackend.
 *
 * All navigation is synchronous and produces stubs holding a path.
 * At await time, backend.resolve(path) runs. Each backend decides
 * how to resolve (client: send messages or serve hydration cache,
 * SSR: walk real graph).
 */

import { formatPath, formatValue } from "./format";
import type { PathSegments } from "./path";
import type { Schema } from "./protocol";
import { RpcError } from "./errors";
import type { RpcStream } from "./types";

export const STUB_PATH: unique symbol = Symbol("graphpc.stubPath");
export const STUB_BACKEND: unique symbol = Symbol("graphpc.stubBackend");
export const STUB_SUBSCRIBE: unique symbol = Symbol("graphpc.stubSubscribe");

export interface ProxyBackend {
  resolve(path: PathSegments): Promise<unknown>;
  subscribe?(path: PathSegments, callback: () => void): () => void;
  openStream?(
    path: PathSegments,
    name: string,
    args: unknown[],
  ): RpcStream<unknown>;
  isStream?(name: string, parentPath: PathSegments): boolean;
}

/**
 * Given a full path and a schema, determine which segments are edges
 * and whether the last segment is a terminal operation (method call
 * or property read), or a stream call.
 *
 * Fully synchronous: walks schema[typeIndex].edges locally.
 * If a segment is in edges, advance the type index.
 * Otherwise it's a terminal operation or a stream.
 */
export function classifyPath(
  path: PathSegments,
  schema: Schema,
): {
  edgePath: PathSegments;
  terminal: { name: string; args: unknown[] } | null;
  stream?: { name: string; args: unknown[] };
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

    // Check if it's a stream
    if (nodeSchema.streams && nodeSchema.streams.includes(segName)) {
      if (i + 1 < path.length) {
        throw new RpcError(
          "INVALID_PATH",
          `Invalid path ${formatPath(path)}: "${segName}" at position ${i} is a stream, not an edge`,
        );
      }
      return {
        edgePath: path.slice(0, i),
        terminal: null,
        stream: { name: segName, args: segArgs },
      };
    }

    // Not an edge or stream — terminal call
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
  // For stubs that represent stream calls on cold clients, lazily create
  // the underlying RpcStream and forward resume/cancel/asyncIterator to it.
  let lazyStream: any = null;
  function getLazyStream() {
    if (lazyStream) return lazyStream;
    const lastSeg = path[path.length - 1];
    if (!Array.isArray(lastSeg) || !backend.openStream) return null;
    const [streamName, ...streamArgs] = lastSeg;
    const parentPath = path.slice(0, -1);
    lazyStream = backend.openStream(
      parentPath,
      streamName as string,
      streamArgs,
    );
    return lazyStream;
  }

  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === STUB_PATH) return path;
      if (prop === STUB_BACKEND) return backend;
      if (prop === STUB_SUBSCRIBE) {
        if (!backend.subscribe) return undefined;
        return (callback: () => void) => {
          return backend.subscribe!(path, callback);
        };
      }
      if (prop === "then") {
        return (
          onFulfilled?: (v: any) => any,
          onRejected?: (e: any) => any,
        ) => {
          return backend.resolve(path).then(onFulfilled, onRejected);
        };
      }
      if (prop === Symbol.asyncIterator && backend.openStream) {
        const s = getLazyStream();
        if (s) return () => s[Symbol.asyncIterator]();
      }
      // Forward resume/cancel to lazy stream if it exists
      if (prop === "resume" && backend.openStream) {
        const s = getLazyStream();
        if (s) return s.resume;
      }
      if (prop === "cancel" && backend.openStream) {
        const s = getLazyStream();
        if (s) return () => s.cancel();
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
    set(_target, prop, value) {
      // Forward resume assignment to lazy stream
      if (prop === "resume" && backend.openStream) {
        const s = getLazyStream();
        if (s) {
          s.resume = value;
          return true;
        }
      }
      return true;
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

  const callCache = new Map<string, any>();

  function callable(...args: unknown[]) {
    if (backend.isStream?.(name, parentPath)) {
      return backend.openStream!(parentPath, name, args);
    }
    const key = args.map((a) => formatValue(a)).join(",");
    let cached = callCache.get(key);
    if (!cached) {
      const callPath: PathSegments = [...parentPath, [name, ...args]];
      cached = createStub(backend, callPath);
      callCache.set(key, cached);
    }
    return cached;
  }

  return new Proxy(callable, {
    get(_target, prop) {
      if (prop === STUB_PATH) return getterPath;
      if (prop === STUB_BACKEND) return backend;
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
      if (prop === STUB_BACKEND) return backend;
      if (prop === STUB_SUBSCRIBE) {
        if (!backend.subscribe) return undefined;
        return (callback: () => void) => {
          return backend.subscribe!(path, callback);
        };
      }
      if (typeof prop === "symbol") return undefined;
      if (Object.hasOwn(target, prop)) return target[prop];
      // Prevent infinite thenable loop — resolved data is not a promise
      if (prop === "then") return undefined;
      // Delegate to stub for continued edge navigation
      return (createStub(backend, path) as any)[prop];
    },
  });
}
