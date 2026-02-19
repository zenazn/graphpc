/**
 * Legacy TypeScript decorators: @edge, @method, @hidden
 *
 * Bun uses legacy (experimentalDecorators-style) decorators:
 *   (target, propertyKey, descriptor)
 *
 * Metadata is stored via WeakMaps keyed by constructor identity.
 * Schemas use Standard Schema (https://standardschema.dev/).
 *
 * @edge(TargetClass) — first arg is always the target class constructor.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Context } from "./types.ts";
import { Node } from "./types.ts";
import { ValidationError } from "./errors.ts";

export interface EdgeMeta {
  name: string;
  kind: "getter" | "method";
  targetType: new (...args: any[]) => any;
  schemas: StandardSchemaV1[];
  paramNames: string[];
}

export interface MethodMeta {
  name: string;
  schemas: StandardSchemaV1[];
  paramNames: string[];
}

// -- Metadata storage (WeakMaps keyed by constructor) --

const edgesMap = new WeakMap<Function, Map<string, EdgeMeta>>();
const methodsMap = new WeakMap<Function, Map<string, MethodMeta>>();

function getOrCreate<V>(
  ctor: Function,
  store: WeakMap<Function, Map<string, V>>,
): Map<string, V> {
  let map = store.get(ctor);
  if (!map) {
    map = new Map();
    store.set(ctor, map);
  }
  return map;
}

const collectCache = new WeakMap<
  WeakMap<Function, Map<string, any>>,
  WeakMap<Function, Map<string, any>>
>();

function collectFromChain<V>(
  cls: Function,
  store: WeakMap<Function, Map<string, V>>,
): Map<string, V> {
  let storeCache = collectCache.get(store);
  if (!storeCache) {
    storeCache = new WeakMap();
    collectCache.set(store, storeCache);
  }
  const cached = storeCache.get(cls);
  if (cached) return cached as Map<string, V>;

  const result = new Map<string, V>();
  let current: any = cls;
  while (current && current !== Function.prototype) {
    const own = store.get(current);
    if (own) {
      for (const [name, val] of own) {
        if (!result.has(name)) result.set(name, val);
      }
    }
    current = Object.getPrototypeOf(current);
  }
  storeCache.set(cls, result);
  return result;
}

export function getEdges(
  cls: new (...args: any[]) => any,
): Map<string, EdgeMeta> {
  return collectFromChain(cls, edgesMap);
}

export function getMethods(
  cls: new (...args: any[]) => any,
): Map<string, MethodMeta> {
  return collectFromChain(cls, methodsMap);
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
    typeof (v as any)["~standard"] === "object"
  );
}

// -- @edge decorator --

function applyEdge(
  targetType: new (...args: any[]) => any,
  schemas: StandardSchemaV1[],
  target: object,
  propertyKey: string,
  descriptor: PropertyDescriptor,
) {
  const ctor = target.constructor;
  const edges = getOrCreate(ctor, edgesMap);
  const isGetter = !!descriptor.get;
  const fn = isGetter ? descriptor.get! : descriptor.value;
  const paramNames = isGetter ? [] : extractParamNames(fn);

  edges.set(propertyKey, {
    name: propertyKey,
    kind: isGetter ? "getter" : "method",
    targetType,
    schemas,
    paramNames,
  });
}

function isConstructor(v: unknown): v is new (...args: any[]) => any {
  return typeof v === "function" && !isStandardSchema(v);
}

/**
 * @edge(TargetClass) — marks a getter or method as an edge (returns a navigable node).
 *
 * Usage:
 *   @edge(UsersService) get users(): UsersService { ... }
 *   @edge(User, z.string()) get(id: string): User { ... }
 */
export function edge(
  targetType: new (...args: any[]) => any,
  ...rest: any[]
): any {
  if (!isConstructor(targetType)) {
    throw new Error("@edge requires a target class as the first argument");
  }
  if (!(targetType.prototype instanceof Node)) {
    throw new Error(`@edge target ${targetType.name} must extend Node`);
  }
  const schemas = rest.filter(isStandardSchema);
  return (
    target: object,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ) => {
    applyEdge(targetType, schemas, target, propertyKey, descriptor);
  };
}

// -- @method decorator --

function applyMethod(
  schemas: StandardSchemaV1[],
  target: object,
  propertyKey: string,
  descriptor: PropertyDescriptor,
) {
  const ctor = target.constructor;
  const methods = getOrCreate(ctor, methodsMap);
  const fn = descriptor.value;
  const paramNames = extractParamNames(fn);

  methods.set(propertyKey, {
    name: propertyKey,
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
  // Case 1: @method (no arguments)
  if (
    args.length === 3 &&
    typeof args[1] === "string" &&
    typeof args[2] === "object" &&
    args[2] !== null &&
    "value" in args[2]
  ) {
    applyMethod([], args[0], args[1], args[2]);
    return;
  }
  // Case 2: @method(schema1, ...)
  const schemas = args.filter(isStandardSchema);
  return (
    target: object,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ) => {
    applyMethod(schemas, target, propertyKey, descriptor);
  };
}

// -- @hidden decorator --

const hiddenMap = new WeakMap<Function, Map<string, HiddenPredicate>>();

export type HiddenPredicate = (this: void, ctx: Context) => boolean;

export function getHidden(
  cls: new (...args: any[]) => any,
): Map<string, HiddenPredicate> {
  return collectFromChain(cls, hiddenMap);
}

export function isHidden(
  cls: new (...args: any[]) => any,
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
  return (target: object, key: string, _descriptor?: PropertyDescriptor) => {
    const ctor = target.constructor;
    getOrCreate(ctor, hiddenMap).set(key, predicate);
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
