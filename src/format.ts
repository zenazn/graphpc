/**
 * Human-readable formatting for paths and values.
 *
 * Produces unambiguous strings like `root.posts.get("42")` for paths
 * and `{a: 1, b: "hello"}` for values. Useful for error messages,
 * debugging, and logging.
 *
 * Supports the same `reducers` interface as devalue's `stringify()`.
 */

import type { PathSegments, PathSegment } from "./path.ts";

type Reducers = Record<string, (value: unknown) => false | unknown[]>;

const IS_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

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

export function formatValue(value: unknown, reducers?: Reducers): string {
  const seen = new Map<object, number>();
  const reducerEntries = reducers
    ? Object.getOwnPropertyNames(reducers)
    : undefined;
  return fmt(value, seen, reducers, reducerEntries);
}

export function formatPath(path: PathSegments, reducers?: Reducers): string {
  const seen = new Map<object, number>();
  const reducerEntries = reducers
    ? Object.getOwnPropertyNames(reducers)
    : undefined;
  let out = "root";
  for (const seg of path) {
    out += fmtSegment(seg, seen, reducers, reducerEntries);
  }
  return out;
}

export function formatSegment(seg: PathSegment, reducers?: Reducers): string {
  const seen = new Map<object, number>();
  const reducerEntries = reducers
    ? Object.getOwnPropertyNames(reducers)
    : undefined;
  return fmtSegment(seg, seen, reducers, reducerEntries);
}

function fmtSegment(
  seg: PathSegment,
  seen: Map<object, number>,
  reducers: Reducers | undefined,
  reducerEntries: string[] | undefined,
): string {
  if (typeof seg === "string") {
    return IS_IDENT.test(seg) ? "." + seg : "[" + JSON.stringify(seg) + "]";
  }
  // Call segment: [name, ...args]
  const [name, ...args] = seg;
  const fmtArgs = args
    .map((a) => fmt(a, seen, reducers, reducerEntries))
    .join(", ");
  return (
    (IS_IDENT.test(name) ? "." : "[" + JSON.stringify(name) + "].") +
    name +
    "(" +
    fmtArgs +
    ")"
  );
}

function fmt(
  thing: unknown,
  seen: Map<object, number>,
  reducers: Reducers | undefined,
  reducerEntries: string[] | undefined,
): string {
  // Primitives
  if (thing === undefined) return "undefined";
  if (thing === null) return "null";

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
      if (result) {
        return (
          name +
          "(" +
          result.map((a) => fmt(a, seen, reducers, reducerEntries)).join(", ") +
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
          fmt(k, seen, reducers, reducerEntries) +
            " => " +
            fmt(v, seen, reducers, reducerEntries),
        );
      }
      return "Map(" + entries.join(", ") + ")";
    }
    case "Set": {
      const s = thing as Set<unknown>;
      const items: string[] = [];
      for (const v of s) {
        items.push(fmt(v, seen, reducers, reducerEntries));
      }
      return "Set(" + items.join(", ") + ")";
    }
    case "Number":
      return (
        "Number(" +
        fmt((thing as Number).valueOf(), seen, reducers, reducerEntries) +
        ")"
      );
    case "String":
      return (
        "String(" +
        fmt((thing as String).valueOf(), seen, reducers, reducerEntries) +
        ")"
      );
    case "Boolean":
      return (
        "Boolean(" +
        fmt((thing as Boolean).valueOf(), seen, reducers, reducerEntries) +
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
      items.push(fmt(v, seen, reducers, reducerEntries));
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
        items.push(fmt(thing[i], seen, reducers, reducerEntries));
      }
    }
    return "[" + items.join(", ") + "]";
  }

  // Plain objects (with or without prototype)
  const proto = Object.getPrototypeOf(thing);
  if (proto === null || proto === Object.prototype) {
    const prefix = proto === null ? "[Object: null prototype] " : "";
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
          ),
      );
    }
    return prefix + "{" + entries.join(", ") + "}";
  }

  // Unknown object type
  return "[" + tag + "]";
}
