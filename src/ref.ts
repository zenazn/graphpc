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
import {
  getSession,
  getNode,
  invalidateEntry,
  type CacheEntry,
} from "./context.ts";
import { resolveEdge, resolveData } from "./resolve.ts";
import { Reference } from "./reference.ts";
import { Path } from "./node-path.ts";
export { Reference, isReference } from "./reference.ts";

const RECORDED_PATH = Symbol("graphpc.recordedPath");

/**
 * Create a cache entry whose resolve function chains through a parent entry.
 * Used by walkPath and ref() to ensure all path segments have entries.
 */
function makeCacheEntry(
  parentKey: string,
  edgeName: string,
  args: unknown[],
  cache: Map<string, CacheEntry>,
  ctx: Context,
): CacheEntry {
  return {
    promise: null,
    settled: false,
    resolve: () => {
      const parentEntry = cache.get(parentKey)!;
      return getNode(parentEntry).then((parent) =>
        resolveEdge(parent, edgeName, args, ctx),
      );
    },
  };
}

/**
 * Ensure the cache has entries for every segment of a path.
 * Creates missing entries with resolve functions that chain through parents.
 * Returns the leaf cache key.
 */
function ensurePathEntries(
  path: PathSegments,
  cache: Map<string, CacheEntry>,
  reducers: Record<string, (value: unknown) => false | unknown[]> | undefined,
  ctx: Context,
): string {
  let cacheKey = "root";
  for (const seg of path) {
    const parentKey = cacheKey;
    cacheKey += formatSegment(seg, reducers);
    if (!cache.has(cacheKey)) {
      const edgeName = typeof seg === "string" ? seg : seg[0];
      const args = typeof seg === "string" ? [] : (seg.slice(1) as unknown[]);
      cache.set(
        cacheKey,
        makeCacheEntry(parentKey, edgeName, args, cache, ctx),
      );
    }
  }
  return cacheKey;
}

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

  // 2. Ensure all cache entries exist and get the leaf key
  const session = getSession();

  // Ensure root entry exists (production code creates it at connection
  // start; this handles ref() in unit-test sessions with empty caches).
  if (!session.nodeCache.has("root")) {
    const r = session.root;
    session.nodeCache.set("root", {
      promise: Promise.resolve(r),
      settled: true,
      resolve: () => Promise.resolve(r),
    });
  }

  const leafKey = ensurePathEntries(
    path,
    session.nodeCache,
    session.reducers,
    session.ctx,
  );

  // 3. Force-invalidate the leaf (always re-resolve, regardless of state)
  const leafEntry = session.nodeCache.get(leafKey)!;
  leafEntry.promise = null;
  leafEntry.settled = false;

  // 4. Invalidate settled descendants so they re-resolve through the fresh leaf
  for (const [key, entry] of session.nodeCache) {
    if (key !== leafKey && key.startsWith(leafKey)) {
      invalidateEntry(entry);
    }
  }

  // 5. Get fresh node via the lazy resolve chain
  const node = await getNode(leafEntry);

  // 6. Return Reference with path + extracted data
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
 * Ensures cache entries exist for every segment and resolves the leaf.
 * The root entry is created automatically if not already in the cache.
 */
export async function walkPath(
  root: object,
  path: PathSegments,
  cache: Map<string, CacheEntry>,
  reducers: Record<string, (value: unknown) => false | unknown[]> | undefined,
  ctx: Context,
): Promise<object> {
  // Ensure root entry exists
  if (!cache.has("root")) {
    cache.set("root", {
      promise: Promise.resolve(root),
      settled: true,
      resolve: () => Promise.resolve(root),
    });
  }

  const leafKey = ensurePathEntries(path, cache, reducers, ctx);
  return getNode(cache.get(leafKey)!);
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
