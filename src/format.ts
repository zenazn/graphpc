/**
 * Human-readable formatting for paths and values.
 *
 * Produces unambiguous strings like `root.posts.get("42")` for paths
 * and `{a: 1, b: "hello"}` for values. Useful for error messages,
 * debugging, and logging.
 *
 * Supports the same `reducers` interface as devalue's `stringify()`.
 */

import type { PathSegments, PathSegment } from "./path";
import { ValidationError } from "./errors";

export type Reducers = Record<string, (value: unknown) => false | unknown[]>;

const IS_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Hard recursion bound for fmt(). Set far below the engine's call-stack limit
 * so that over-nesting raises a deterministic, catchable signal at a fixed
 * depth instead of a RangeError that fires at a runtime-dependent depth.
 *
 * This determinism is load-bearing for cache-key correctness: formatKeySegment
 * must never collapse two structurally distinct arguments to the same key (that
 * would resolve the wrong node — see the object branch of fmt). The previous
 * code returned a constant "[unformattable]" sentinel whenever the recursion
 * happened to overflow the stack, so two distinct deep args could alias one
 * NodeEntry. With a fixed bound, formatKeySegment can reliably detect and reject
 * un-keyable input rather than emit a non-injective key.
 */
const MAX_FMT_DEPTH = 1000;

/** Thrown by fmt() when input nests deeper than MAX_FMT_DEPTH. */
class FormatDepthError extends Error {}

const TYPED_ARRAY_TAGS = new Set([
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

/**
 * Recover from over-deep input. fmt() throws FormatDepthError past
 * MAX_FMT_DEPTH (and a RangeError would mean the engine's call stack was
 * exhausted first, which the bound makes unreachable in practice). Returning a
 * sentinel keeps display callers — logging/metrics that format untrusted args
 * outside a request's try/catch — from crashing. The cache-key path
 * (formatKeySegment) deliberately does NOT use this and instead rejects, since
 * a constant sentinel would not be an injective key.
 */
function safeFmt(produce: () => string): string {
  try {
    return produce();
  } catch (e) {
    if (e instanceof RangeError || e instanceof FormatDepthError)
      return "[unformattable: too deeply nested]";
    throw e;
  }
}

export function formatValue(value: unknown, reducers?: Reducers): string {
  const seen = new Map<object, number>();
  const reducerEntries = reducers
    ? Object.getOwnPropertyNames(reducers)
    : undefined;
  return safeFmt(() => fmt(value, seen, reducers, reducerEntries, 0));
}

export function formatPath(path: PathSegments, reducers?: Reducers): string {
  const seen = new Map<object, number>();
  const reducerEntries = reducers
    ? Object.getOwnPropertyNames(reducers)
    : undefined;
  return safeFmt(() => {
    let out = "root";
    for (const seg of path) {
      out += fmtSegment(seg, seen, reducers, reducerEntries, 0);
    }
    return out;
  });
}

/**
 * True when `candidate` is a strict descendant of `ancestor`.
 *
 * Both keys must be produced by formatPath/formatSegment. A descendant
 * starts with the full ancestor key and then immediately continues with
 * a new segment delimiter ('.' or '['), preventing false matches like
 * "root.post" vs "root.posts".
 */
export function isDescendantPathKey(
  ancestor: string,
  candidate: string,
): boolean {
  if (candidate === ancestor) return false;
  if (!candidate.startsWith(ancestor)) return false;
  const next = candidate[ancestor.length];
  return next === "." || next === "[";
}

export function formatSegment(seg: PathSegment, reducers?: Reducers): string {
  const seen = new Map<object, number>();
  const reducerEntries = reducers
    ? Object.getOwnPropertyNames(reducers)
    : undefined;
  return safeFmt(() => fmtSegment(seg, seen, reducers, reducerEntries, 0));
}

/**
 * Max length of a single formatted path segment when used as a cache key.
 * Untrusted edge arguments can be arbitrarily large; a segment longer than
 * this is truncated and disambiguated with a hash of its full content, so
 * retained key memory stays bounded (O(maxDepth × cap) per token) regardless
 * of argument size — while distinct arguments still map to distinct keys.
 */
export const KEY_SEGMENT_MAX_LEN = 1024;

/**
 * cyrb53 — fast, well-distributed non-cryptographic string hash. Used only to
 * keep truncated cache keys distinct; not a security primitive.
 */
function hashString(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * Format a path segment for use as a server-side cache key, bounding the
 * output length. For normal-sized segments this is byte-identical to
 * `formatSegment`; only pathologically large segments are truncated (and a
 * content hash + original length appended) so they cannot bloat the server's
 * per-token key storage. Truncation preserves the descendant-prefix property
 * relied on by `isDescendantPathKey` (a child key is still the parent key
 * followed by a `.`/`[` segment).
 */
export function formatKeySegment(
  seg: PathSegment,
  reducers?: Reducers,
): string {
  // Unlike formatSegment (which goes through safeFmt and degrades to a constant
  // sentinel), the cache-key path must produce an INJECTIVE key. Format the
  // segment directly so an over-deep argument surfaces as a rejectable error
  // rather than the non-injective "[unformattable]" sentinel that would alias
  // two distinct arguments to one node.
  let s: string;
  try {
    const seen = new Map<object, number>();
    const reducerEntries = reducers
      ? Object.getOwnPropertyNames(reducers)
      : undefined;
    s = fmtSegment(seg, seen, reducers, reducerEntries, 0);
  } catch (e) {
    if (e instanceof RangeError || e instanceof FormatDepthError) {
      throw new ValidationError([
        { message: "Edge argument is too deeply nested" },
      ]);
    }
    throw e;
  }
  if (s.length <= KEY_SEGMENT_MAX_LEN) return s;
  return s.slice(0, KEY_SEGMENT_MAX_LEN) + "#" + hashString(s) + "~" + s.length;
}

function fmtSegment(
  seg: PathSegment,
  seen: Map<object, number>,
  reducers: Reducers | undefined,
  reducerEntries: string[] | undefined,
  depth: number,
): string {
  if (typeof seg === "string") {
    return IS_IDENT.test(seg) ? "." + seg : "[" + JSON.stringify(seg) + "]";
  }
  // Call segment: [name, ...args]
  const [name, ...args] = seg;
  const fmtArgs = args
    .map((a) => fmt(a, seen, reducers, reducerEntries, depth + 1))
    .join(", ");
  if (IS_IDENT.test(name)) {
    return "." + name + "(" + fmtArgs + ")";
  }
  const quoted = JSON.stringify(name);
  return "[" + quoted + "](" + fmtArgs + ")";
}

function fmt(
  thing: unknown,
  seen: Map<object, number>,
  reducers: Reducers | undefined,
  reducerEntries: string[] | undefined,
  depth: number,
): string {
  // Primitives
  if (thing === undefined) return "undefined";
  if (thing === null) return "null";

  // Deterministic depth bound (see MAX_FMT_DEPTH). Checked after the primitive
  // fast-paths so only nested (object/array) values can trip it.
  if (depth > MAX_FMT_DEPTH) throw new FormatDepthError();

  switch (typeof thing) {
    case "string":
      return JSON.stringify(thing);
    case "number":
      if (Number.isNaN(thing)) return "NaN";
      if (thing === Infinity) return "Infinity";
      if (thing === -Infinity) return "-Infinity";
      if (Object.is(thing, -0)) return "-0";
      return String(thing);
    case "boolean":
      return String(thing);
    case "bigint":
      return thing + "n";
    case "symbol":
      return (
        "Symbol(" +
        (thing.description !== undefined
          ? JSON.stringify(thing.description)
          : "") +
        ")"
      );
    case "function":
      return "[Function]";
  }

  // Objects — circular reference tracking
  const obj = thing as object;
  if (seen.has(obj)) return "$" + seen.get(obj)!;
  const idx = seen.size;
  seen.set(obj, idx);

  // Custom reducers
  if (reducerEntries) {
    for (const name of reducerEntries) {
      const result = reducers![name]!(thing);
      // The Reducers contract is `false | unknown[]`. Require an array before
      // mapping so a misconfigured reducer returning a truthy non-array doesn't
      // throw "result.map is not a function" out of logging/error/SSR/cache-key
      // paths — it simply doesn't claim the value (falls through to default).
      if (Array.isArray(result)) {
        return (
          name +
          "(" +
          result
            .map((a) => fmt(a, seen, reducers, reducerEntries, depth + 1))
            .join(", ") +
          ")"
        );
      }
    }
  }

  // Built-in object types
  const tag = Object.prototype.toString.call(thing).slice(8, -1);

  switch (tag) {
    case "Date": {
      const d = thing as Date;
      return isNaN(d.getTime())
        ? "Date(Invalid)"
        : "Date(" + JSON.stringify(d.toISOString()) + ")";
    }
    case "RegExp": {
      const r = thing as RegExp;
      return "/" + r.source + "/" + r.flags;
    }
    case "URL":
      return "URL(" + JSON.stringify((thing as URL).href) + ")";
    case "URLSearchParams":
      return (
        "URLSearchParams(" +
        JSON.stringify((thing as URLSearchParams).toString()) +
        ")"
      );
    case "Map": {
      const m = thing as Map<unknown, unknown>;
      const entries: string[] = [];
      for (const [k, v] of m) {
        entries.push(
          fmt(k, seen, reducers, reducerEntries, depth + 1) +
            " => " +
            fmt(v, seen, reducers, reducerEntries, depth + 1),
        );
      }
      return "Map(" + entries.join(", ") + ")";
    }
    case "Set": {
      const s = thing as Set<unknown>;
      const items: string[] = [];
      for (const v of s) {
        items.push(fmt(v, seen, reducers, reducerEntries, depth + 1));
      }
      return "Set(" + items.join(", ") + ")";
    }
    case "Number":
      return (
        "Number(" +
        fmt(
          (thing as Number).valueOf(),
          seen,
          reducers,
          reducerEntries,
          depth + 1,
        ) +
        ")"
      );
    case "String":
      return (
        "String(" +
        fmt(
          (thing as String).valueOf(),
          seen,
          reducers,
          reducerEntries,
          depth + 1,
        ) +
        ")"
      );
    case "Boolean":
      return (
        "Boolean(" +
        fmt(
          (thing as Boolean).valueOf(),
          seen,
          reducers,
          reducerEntries,
          depth + 1,
        ) +
        ")"
      );
    case "ArrayBuffer":
      return "ArrayBuffer(" + (thing as ArrayBuffer).byteLength + ")";
  }

  // Typed arrays
  if (TYPED_ARRAY_TAGS.has(tag)) {
    const arr = thing as {
      [Symbol.iterator](): Iterator<unknown>;
      length: number;
    };
    const items: string[] = [];
    for (const v of arr) {
      items.push(fmt(v, seen, reducers, reducerEntries, depth + 1));
    }
    return tag + "([" + items.join(", ") + "])";
  }

  // Temporal (when available)
  if (tag.startsWith("Temporal.")) {
    return tag + "(" + JSON.stringify(String(thing)) + ")";
  }

  // Array (including sparse)
  if (Array.isArray(thing)) {
    const items: string[] = [];
    for (let i = 0; i < thing.length; i++) {
      if (!(i in thing)) {
        items.push("<hole>");
      } else {
        items.push(fmt(thing[i], seen, reducers, reducerEntries, depth + 1));
      }
    }
    return "[" + items.join(", ") + "]";
  }

  // Plain objects (with or without prototype) and other class instances.
  // Both render their own enumerable properties so that structurally-distinct
  // values produce distinct strings. This matters for cache keys: a class
  // instance (e.g. a PathArg/Path/Reference, or an app domain object passed as
  // an edge argument) must not collapse to a content-free "[Tag]" — that would
  // give two different arguments the same key and resolve the wrong node.
  const proto = Object.getPrototypeOf(thing);
  const entries: string[] = [];
  for (const key of Object.keys(thing as Record<string, unknown>)) {
    const fmtKey = IS_IDENT.test(key) ? key : JSON.stringify(key);
    entries.push(
      fmtKey +
        ": " +
        fmt(
          (thing as Record<string, unknown>)[key],
          seen,
          reducers,
          reducerEntries,
          depth + 1,
        ),
    );
  }
  const body = "{" + entries.join(", ") + "}";

  if (proto === null) return "[Object: null prototype] " + body;
  if (proto === Object.prototype) return body;

  // Other class instance: prefix with the constructor name so two different
  // classes with the same field shape still format distinctly.
  const ctorName =
    (typeof proto.constructor === "function" && proto.constructor.name) || tag;
  return ctorName + " " + body;
}
