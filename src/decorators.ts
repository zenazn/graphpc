/**
 * TC39 stage 3 decorators: @edge, @method, @hidden
 *
 * Decorators receive (value, context) per the TC39 spec.
 * Metadata is stored in a single WeakMap keyed by the decorator metadata
 * object that Bun attaches to each class.
 * Schemas use Standard Schema (https://standardschema.dev/).
 *
 * @edge(TargetClass) — first arg is always the target class constructor.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Context } from "./types";
import { Node } from "./types";
import { ValidationError } from "./errors";

export interface EdgeMeta {
  name: string;
  kind: "getter" | "method";
  targetType: new (...args: any[]) => object;
  schemas: StandardSchemaV1[];
  paramNames: string[];
}

export interface MethodMeta {
  name: string;
  schemas: StandardSchemaV1[];
  paramNames: string[];
}

export interface StreamMeta {
  name: string;
  schemas: StandardSchemaV1[];
  paramNames: string[];
}

// -- Metadata storage --

interface ClassMeta {
  edges: Map<string, EdgeMeta>;
  methods: Map<string, MethodMeta>;
  streams: Map<string, StreamMeta>;
  hidden: Map<string, HiddenPredicate>;
}

/**
 * Own (non-inherited) metadata per class, keyed by the DecoratorMetadataObject
 * that Bun attaches during class definition. Decorators write here via
 * context.metadata; getEdges/getMethods/getHidden read via the constructor's
 * metadata attachment.
 */
const metadataMap = new WeakMap<object, ClassMeta>();

/** Bun's internal key for decorator metadata on constructors. */
const METADATA = Symbol.for("Symbol.metadata");

function getOrCreateMeta(metadata: object): ClassMeta {
  let meta = metadataMap.get(metadata);
  if (!meta) {
    meta = {
      edges: new Map(),
      methods: new Map(),
      streams: new Map(),
      hidden: new Map(),
    };
    metadataMap.set(metadata, meta);
  }
  return meta;
}

/** Cache of collected (own + inherited) metadata per class. */
const collectCache = new WeakMap<object, ClassMeta>();

/**
 * Walk the metadata prototype chain and merge own + inherited metadata.
 * Child entries take precedence over parent entries with the same name.
 */
function collect(cls: Function): ClassMeta {
  const metadata = (cls as unknown as Record<symbol, object | undefined>)[
    METADATA
  ];
  if (!metadata)
    return {
      edges: new Map(),
      methods: new Map(),
      streams: new Map(),
      hidden: new Map(),
    };

  const cached = collectCache.get(metadata);
  if (cached) return cached;

  const result: ClassMeta = {
    edges: new Map(),
    methods: new Map(),
    streams: new Map(),
    hidden: new Map(),
  };
  let current: object | null = metadata;
  while (current) {
    const own = metadataMap.get(current);
    if (own) {
      for (const [name, val] of own.edges) {
        if (!result.edges.has(name)) result.edges.set(name, val);
      }
      for (const [name, val] of own.methods) {
        if (!result.methods.has(name)) result.methods.set(name, val);
      }
      for (const [name, val] of own.streams) {
        if (!result.streams.has(name)) result.streams.set(name, val);
      }
      for (const [name, val] of own.hidden) {
        if (!result.hidden.has(name)) result.hidden.set(name, val);
      }
    }
    current = Object.getPrototypeOf(current);
  }

  collectCache.set(metadata, result);
  return result;
}

export function getEdges(
  cls: new (...args: any[]) => object,
): Map<string, EdgeMeta> {
  const edges = collect(cls).edges;
  // Resolve any lazy target references (thunks from @edge(() => Class))
  for (const meta of edges.values()) {
    if (!(meta.targetType.prototype instanceof Node)) {
      meta.targetType = (
        meta.targetType as unknown as () => new (...args: any[]) => object
      )();
      if (!(meta.targetType.prototype instanceof Node)) {
        throw new Error(
          `@edge thunk for "${meta.name}" did not return a Node subclass`,
        );
      }
    }
  }
  return edges;
}

export function getMethods(
  cls: new (...args: any[]) => object,
): Map<string, MethodMeta> {
  return collect(cls).methods;
}

export function getStreams(
  cls: new (...args: any[]) => object,
): Map<string, StreamMeta> {
  return collect(cls).streams;
}

// -- Helpers --

/**
 * Skips past a string literal (single-quoted, double-quoted, or template).
 * `start` is the index of the opening quote character.
 * Returns the index of the closing quote character.
 */
function skipString(src: string, start: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (quote === "`" && src[i] === "$" && src[i + 1] === "{") {
      // Template literal interpolation — track nested braces
      let braceDepth = 1;
      i += 2;
      while (i < src.length && braceDepth > 0) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
          i = skipString(src, i) + 1;
          continue;
        }
        if (src[i] === "{") braceDepth++;
        else if (src[i] === "}") braceDepth--;
        if (braceDepth > 0) i++;
      }
      // i is now at the closing '}' of the interpolation
      i++;
      continue;
    }
    if (src[i] === quote) return i;
    i++;
  }
  return src.length - 1;
}

/**
 * Advances past a comment if one starts at position `i`.
 * Returns the new index to continue scanning from, or -1 if not a comment.
 */
function skipComment(src: string, i: number): number {
  if (src[i] !== "/") return -1;
  if (src[i + 1] === "/") {
    // Line comment — skip to end of line
    const nl = src.indexOf("\n", i + 2);
    return nl === -1 ? src.length : nl;
  }
  if (src[i + 1] === "*") {
    // Block comment — skip to closing */
    const close = src.indexOf("*/", i + 2);
    return close === -1 ? src.length : close + 2;
  }
  return -1;
}

/**
 * Extracts parameter names from a function's source via `fn.toString()`.
 *
 * This is intentionally used only for *error messages* (e.g. "name: Expected string"
 * in validation errors), never for routing, dispatch, or any behavioral logic.
 * If extraction fails or names are mangled, the fallback is "arg0", "arg1", etc.
 *
 * Why `fn.toString()` is safe here:
 * - The output format for regular functions, methods, arrow functions, and getters
 *   is standardized in ES2019+ (Function.prototype.toString revision, §19.2.3.5).
 *   V8, SpiderMonkey, and JavaScriptCore all conform. See tests in decorators.test.ts.
 * - Minification is irrelevant: this library's decorators run against *source* class
 *   definitions (not minified bundles), since decorators execute at class definition
 *   time on the server side.
 */
function extractParamNames(fn: Function): string[] {
  const src = fn.toString();

  // Find the opening '(' of the parameter list
  const start = src.indexOf("(");
  if (start === -1) return [];

  // Walk forward to find the matching ')' at depth 0,
  // skipping string literals and comments
  let depth = 0;
  let end = -1;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    // Skip strings
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(src, i);
      continue;
    }
    // Skip comments
    const commentEnd = skipComment(src, i);
    if (commentEnd !== -1) {
      i = commentEnd - 1;
      continue;
    }

    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return [];

  const inner = src.slice(start + 1, end);
  if (!inner.trim()) return [];

  // Split by commas at depth 0 only, skipping strings and comments
  const params: string[] = [];
  depth = 0;
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    // Skip strings
    if (ch === '"' || ch === "'" || ch === "`") {
      const strEnd = skipString(inner, i);
      current += inner.slice(i, strEnd + 1);
      i = strEnd;
      continue;
    }
    // Skip comments
    const commentEnd = skipComment(inner, i);
    if (commentEnd !== -1) {
      current += inner.slice(i, commentEnd);
      i = commentEnd - 1;
      continue;
    }

    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      params.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  params.push(current);

  return params
    .map((p) => {
      const trimmed = p
        .trim()
        .replace(/\s*=.*$/, "")
        .replace(/^\.\.\.\s*/, "");
      // Destructured params ({ a, b } or [a, b]) have no single meaningful name
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "";
      return trimmed;
    })
    .map((name, i) => name || `arg${i}`)
    .filter(Boolean);
}

function isStandardSchema(v: unknown): v is StandardSchemaV1 {
  return (
    typeof v === "object" &&
    v !== null &&
    "~standard" in v &&
    typeof (v as Record<string, unknown>)["~standard"] === "object"
  );
}

// -- @edge decorator --

/**
 * @edge(TargetClass) — marks a getter or method as an edge (returns a navigable node).
 *
 * The first argument is the target class (must extend Node), or a thunk returning
 * one for self-referential / circular edges: @edge(() => NodeA).
 *
 * Usage:
 *   @edge(UsersService) get users(): UsersService { ... }
 *   @edge(User, z.string()) get(id: string): User { ... }
 *   @edge(() => TreeNode) get children(): TreeNode[] { ... }
 */
export function edge(
  target:
    | (new (...args: any[]) => object)
    | (() => new (...args: any[]) => object),
  ...rest: unknown[]
): any {
  if (typeof target !== "function" || isStandardSchema(target)) {
    throw new Error("@edge requires a target class as the first argument");
  }
  // Validate eagerly when possible (direct class reference)
  if (target.prototype instanceof Node) {
    // Direct class — validated
  } else if (target.prototype !== undefined) {
    // Has a prototype but not a Node subclass — not a thunk either
    throw new Error(
      `@edge target ${target.name} must extend Node (or use a thunk: @edge(() => Class))`,
    );
  }
  // else: no .prototype (arrow function thunk) — deferred validation in getEdges()
  const schemas = rest.filter(isStandardSchema);
  return (
    value: Function,
    context: ClassGetterDecoratorContext | ClassMethodDecoratorContext,
  ) => {
    const name = context.name as string;
    const isGetter = context.kind === "getter";
    const paramNames = isGetter ? [] : extractParamNames(value);
    getOrCreateMeta(context.metadata).edges.set(name, {
      name,
      kind: isGetter ? "getter" : "method",
      targetType: target as new (...args: any[]) => object,
      schemas,
      paramNames,
    });
  };
}

// -- @method decorator --

function applyMethod(
  schemas: StandardSchemaV1[],
  value: Function,
  context: ClassMethodDecoratorContext,
) {
  const name = context.name as string;
  const paramNames = extractParamNames(value);
  getOrCreateMeta(context.metadata).methods.set(name, {
    name,
    schemas,
    paramNames,
  });
}

/**
 * @method — marks a method as callable by the client (returns data over the wire).
 *
 * Usage:
 *   @method async list(): Promise<Item[]> { ... }
 *   @method(z.string().email()) async updateEmail(email: string): Promise<void> { ... }
 */
export function method(...args: any[]): any {
  // Case 1: @method (bare, no arguments) — TC39 calls method(value, context)
  if (
    args.length === 2 &&
    typeof args[0] === "function" &&
    typeof args[1] === "object" &&
    args[1] !== null &&
    "kind" in args[1] &&
    args[1].kind === "method"
  ) {
    applyMethod([], args[0], args[1]);
    return;
  }
  // Case 2: @method(schema1, ...)
  const schemas = args.filter(isStandardSchema);
  return (value: Function, context: ClassMethodDecoratorContext) => {
    applyMethod(schemas, value, context);
  };
}

// -- @hidden decorator --

export type HiddenPredicate = (this: void, ctx: Context) => boolean;

export function getHidden(
  cls: new (...args: any[]) => object,
): Map<string, HiddenPredicate> {
  return collect(cls).hidden;
}

export function isHidden(
  cls: new (...args: any[]) => object,
  propertyName: string,
  ctx: Context,
): boolean {
  const predicate = getHidden(cls).get(propertyName);
  if (!predicate) return false;
  return predicate.call(undefined, ctx);
}

/**
 * @hidden((ctx) => boolean) — conditionally hides an edge, method, or data field from a connection's view.
 *
 * Returns true to hide, false to show. The predicate receives the connection context.
 *
 * Usage:
 *   @hidden((ctx) => !ctx.isAdmin)
 *   @edge(AdminPanel)
 *   get admin(): AdminPanel { ... }
 */
export function hidden(predicate: HiddenPredicate) {
  return (
    _value: Function | undefined,
    context:
      | ClassMethodDecoratorContext
      | ClassGetterDecoratorContext
      | ClassFieldDecoratorContext,
  ) => {
    const name = context.name as string;
    getOrCreateMeta(context.metadata).hidden.set(name, predicate);
  };
}

// -- @stream decorator --

function applyStream(
  schemas: StandardSchemaV1[],
  value: Function,
  context: ClassMethodDecoratorContext,
) {
  const name = context.name as string;
  // Extract param names, skipping the leading AbortSignal
  const allParamNames = extractParamNames(value);
  const paramNames = allParamNames.length > 0 ? allParamNames.slice(1) : [];
  getOrCreateMeta(context.metadata).streams.set(name, {
    name,
    schemas,
    paramNames,
  });
}

/**
 * @stream — marks an async generator method as a server-push stream.
 *
 * The first parameter is always an AbortSignal (provided by the framework).
 * Remaining parameters are validated against Standard Schema validators.
 *
 * Usage:
 *   @stream(z.string().optional())
 *   async *updates(signal: AbortSignal, cursor?: string): AsyncGenerator<Update> { ... }
 */
export function stream(...args: any[]): any {
  // Case 1: @stream (bare, no arguments) — TC39 calls stream(value, context)
  if (
    args.length === 2 &&
    typeof args[0] === "function" &&
    typeof args[1] === "object" &&
    args[1] !== null &&
    "kind" in args[1] &&
    args[1].kind === "method"
  ) {
    applyStream([], args[0], args[1]);
    return;
  }
  // Case 2: @stream(schema1, ...)
  const schemas = args.filter(isStandardSchema);
  return (value: Function, context: ClassMethodDecoratorContext) => {
    applyStream(schemas, value, context);
  };
}

// -- Validate arguments against Standard Schema --

export async function validateArgs(
  schemas: StandardSchemaV1[],
  args: unknown[],
  paramNames: string[],
): Promise<unknown[]> {
  if (args.length > schemas.length) {
    throw new ValidationError([
      {
        message: `Expected ${schemas.length} argument${schemas.length === 1 ? "" : "s"}, got ${args.length}`,
      },
    ]);
  }
  const validated: unknown[] = [];
  for (let i = 0; i < schemas.length; i++) {
    const schema = schemas[i]!;
    const arg = args[i];
    const result = await schema["~standard"].validate(arg);
    if (result.issues) {
      const issues = result.issues.map((issue) => ({
        message: `${paramNames[i] ?? `arg${i}`}: ${issue.message}`,
        path: issue.path as PropertyKey[] | undefined,
      }));
      throw new ValidationError(issues);
    }
    validated.push(result.value);
  }
  return validated;
}
