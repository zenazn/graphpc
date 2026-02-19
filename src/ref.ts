/**
 * async ref(), recording proxy, and walkPath.
 */

import { formatSegment } from "./format.ts";
import type { PathSegments, PathSegment } from "./path.ts";
import {
  canonicalPath,
  Node,
  type CanonicalArgs,
  type Context,
} from "./types.ts";
import { getSession } from "./context.ts";
import { resolveEdge, resolveData } from "./resolve.ts";
import { Reference } from "./reference.ts";
import { Path } from "./node-path.ts";
export { Reference, isReference } from "./reference.ts";

const RECORDED_PATH = Symbol("graphpc.recordedPath");

/**
 * Create a reference to a node via its static [canonicalPath].
 * Must be called inside a request (uses ALS to access root + cache).
 */
export async function ref<
  T extends {
    [canonicalPath]: (root: any, ...args: any[]) => any;
    new (...args: any[]): Node;
  },
>(cls: T, ...args: CanonicalArgs<T>): Promise<Reference<InstanceType<T>>> {
  // 1. Capture path via recording proxy
  if (typeof (cls as any)[canonicalPath] !== "function") {
    throw new Error(`Class ${cls.name} does not have a [canonicalPath] method`);
  }
  const proxy = createRecordingProxy();
  const result = (cls as any)[canonicalPath](proxy, ...args);
  const path = getRecordedPath(result);

  if (!path) {
    throw new Error(
      `[canonicalPath] for ${cls.name} did not return a recorded proxy`,
    );
  }

  // 2. Walk real graph with caching via session from ALS
  const session = getSession();
  const node = await walkPath(
    session.root,
    path,
    session.nodeCache,
    session.reducers,
    session.ctx,
  );

  // 3. Return Reference with path + extracted data
  return new Reference(path, resolveData(node, session.ctx));
}

/**
 * Creates a recording proxy that captures ALL property accesses as path segments.
 * This is used by [canonicalPath] — the proxy doesn't execute anything, it just records
 * the navigation path. Property access records a string segment. Calling the
 * result records a method segment [name, ...args].
 */
export function createRecordingProxy(basePath: PathSegments = []): any {
  function makeProxy(currentPath: PathSegments): any {
    // Return a callable proxy — it can be accessed as a property or called
    const fn = (...args: unknown[]) => {
      // The last segment in currentPath was a property access; convert it to a call
      if (currentPath.length === 0) return makeProxy(currentPath);
      const lastSeg = currentPath[currentPath.length - 1]!;
      if (typeof lastSeg === "string") {
        const newPath = [
          ...currentPath.slice(0, -1),
          [lastSeg, ...args] as PathSegment,
        ];
        return makeProxy(newPath);
      }
      return makeProxy(currentPath);
    };

    return new Proxy(fn, {
      get(_target, prop) {
        if (prop === RECORDED_PATH) return currentPath;
        if (typeof prop === "symbol") return undefined;
        return makeProxy([...currentPath, String(prop)]);
      },
      apply(_target, _thisArg, args) {
        return fn(...args);
      },
    });
  }

  return makeProxy(basePath);
}

export function getRecordedPath(proxy: any): PathSegments | undefined {
  return proxy?.[RECORDED_PATH];
}

/**
 * Walk a path against the real root, resolving each edge segment.
 * Uses a path-keyed node cache from the session to avoid redundant traversals.
 */
export async function walkPath(
  root: object,
  path: PathSegments,
  cache: Map<string, Promise<object>>,
  reducers: Record<string, (value: unknown) => false | unknown[]> | undefined,
  ctx: Context,
): Promise<object> {
  let current = root;
  let cacheKey = "root";

  for (let i = 0; i < path.length; i++) {
    const seg = path[i]!;
    cacheKey += formatSegment(seg, reducers);
    const cached = cache.get(cacheKey);
    if (cached) {
      current = await cached;
      continue;
    }

    const edgeName = typeof seg === "string" ? seg : seg[0];
    const args = typeof seg === "string" ? [] : (seg.slice(1) as unknown[]);

    const promise = resolveEdge(current, edgeName, args, ctx);
    cache.set(cacheKey, promise);
    current = await promise;
  }

  return current;
}

/**
 * Create a Path<T> from a class's [canonicalPath] without walking the graph.
 * Much cheaper than ref() — just records the path segments.
 * The resulting Path<T> serializes as NodePath over the wire;
 * the client receives it as a stub.
 */
export function pathTo<
  T extends {
    [canonicalPath]: (root: any, ...args: any[]) => any;
    new (...args: any[]): Node;
  },
>(cls: T, ...args: CanonicalArgs<T>): Path<InstanceType<T>> {
  if (typeof (cls as any)[canonicalPath] !== "function") {
    throw new Error(`Class ${cls.name} does not have a [canonicalPath] method`);
  }
  const proxy = createRecordingProxy();
  const result = (cls as any)[canonicalPath](proxy, ...args);
  const segments = getRecordedPath(result);

  if (!segments) {
    throw new Error(
      `[canonicalPath] for ${cls.name} did not return a recorded proxy`,
    );
  }

  return new Path(
    segments,
    cls as unknown as new (...a: any[]) => InstanceType<T>,
  );
}
