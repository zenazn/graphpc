/**
 * Server-side resolution: navigate edges, invoke methods, extract data.
 */

import { getEdges, getMethods, isHidden, validateArgs } from "./decorators.ts";
import { EdgeNotFoundError, MethodNotFoundError } from "./errors.ts";
import type { Context } from "./types.ts";

const BLOCKED_NAMES = new Set(["constructor", "__proto__", "prototype"]);

/**
 * Resolve an edge traversal on a node, returning the child node.
 */
export async function resolveEdge(
  parent: object,
  edgeName: string,
  args: unknown[],
  ctx: Context,
): Promise<object> {
  if (BLOCKED_NAMES.has(edgeName)) {
    throw new EdgeNotFoundError(edgeName);
  }

  const cls = parent.constructor as new (...args: any[]) => any;

  if (isHidden(cls, edgeName, ctx)) {
    throw new EdgeNotFoundError(edgeName);
  }

  const edges = getEdges(cls);
  const meta = edges.get(edgeName);

  if (!meta) {
    throw new EdgeNotFoundError(edgeName);
  }

  const validatedArgs = await validateArgs(meta.schemas, args, meta.paramNames);

  if (meta.kind === "getter") {
    // Getter edge: walk prototype chain to find the descriptor
    let descriptor: PropertyDescriptor | undefined;
    let proto = Object.getPrototypeOf(parent);
    while (proto) {
      descriptor = Object.getOwnPropertyDescriptor(proto, edgeName);
      if (descriptor) break;
      proto = Object.getPrototypeOf(proto);
    }
    if (!descriptor)
      descriptor = Object.getOwnPropertyDescriptor(parent, edgeName);
    if (!descriptor?.get) {
      throw new EdgeNotFoundError(edgeName);
    }
    return descriptor.get.call(parent);
  }

  // Method edge: call with validated args
  const fn = (parent as any)[edgeName];
  if (typeof fn !== "function") {
    throw new EdgeNotFoundError(edgeName);
  }
  return fn.apply(parent, validatedArgs);
}

/**
 * Extract public data fields from a node.
 *
 * Includes own enumerable properties and getter/value results from the
 * prototype chain (stopping before Object.prototype). Excludes @edge getters,
 * @method functions, @hidden members, blocked names, and function values.
 */
export function resolveData(
  node: object,
  ctx: Context,
): Record<string, unknown> {
  const cls = node.constructor as new (...args: any[]) => any;
  const edges = getEdges(cls);
  const methods = getMethods(cls);
  const data: Record<string, unknown> = {};

  // Own enumerable properties
  for (const key of Object.keys(node)) {
    if (isHidden(cls, key, ctx)) continue;
    const value = (node as any)[key];
    if (typeof value === "function") continue;
    data[key] = value;
  }

  // Getters and value properties from prototype chain (stop before Object.prototype)
  let proto = Object.getPrototypeOf(node);
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (BLOCKED_NAMES.has(name)) continue;
      if (name in data) continue;
      if (edges.has(name)) continue;
      if (methods.has(name)) continue;
      if (isHidden(cls, name, ctx)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (descriptor?.get) {
        const value = descriptor.get.call(node);
        if (typeof value === "function") continue;
        data[name] = value;
      } else if (descriptor && "value" in descriptor) {
        if (typeof descriptor.value === "function") continue;
        data[name] = descriptor.value;
      }
    }
    proto = Object.getPrototypeOf(proto);
  }

  return data;
}

/**
 * Resolve a `get` operation on a node.
 *
 * Handles three kinds of access through a single op:
 *   1. `@method` invocation — validated args, called as a function
 *   2. Own property read — no args, returns the data value
 *   3. Getter invocation — no args, walks prototype chain (stops before Object.prototype)
 *   4. Prototype value property — no args, non-getter descriptor with a value on prototype
 *
 * Security properties:
 *   - JS builtins (constructor, __proto__, prototype) are blocked
 *   - @edge members can't be accessed via `get` (must use `edge` op)
 *   - Only @method-decorated functions can be called
 *   - Args are only accepted for @method calls
 *   - Prototype chain walk stops at Object.prototype
 *   - Function values from own properties or getters are rejected
 */
export async function resolveGet(
  node: object,
  name: string,
  args: unknown[],
  ctx: Context,
): Promise<unknown> {
  // 1. Block dangerous names
  if (BLOCKED_NAMES.has(name)) {
    throw new MethodNotFoundError(name);
  }

  const cls = node.constructor as new (...args: any[]) => any;

  // 2. Hidden check
  if (isHidden(cls, name, ctx)) {
    throw new MethodNotFoundError(name);
  }

  // 3. @edge members must use the edge op
  const edges = getEdges(cls);
  if (edges.has(name)) {
    throw new MethodNotFoundError(name);
  }

  // 4. @method check — if decorated, validate args and call
  const methods = getMethods(cls);
  const meta = methods.get(name);

  if (meta) {
    const validatedArgs = await validateArgs(
      meta.schemas,
      args,
      meta.paramNames,
    );
    const fn = (node as any)[name];
    if (typeof fn !== "function") {
      throw new MethodNotFoundError(name);
    }
    return fn.apply(node, validatedArgs);
  }

  // 5. Non-@method: args are not allowed
  if (args.length > 0) {
    throw new MethodNotFoundError(name);
  }

  // 6. Own property check
  if (Object.hasOwn(node, name)) {
    const value = (node as any)[name];
    if (typeof value === "function") {
      throw new MethodNotFoundError(name);
    }
    return value;
  }

  // 7. Prototype chain walk (stop before Object.prototype)
  let proto = Object.getPrototypeOf(node);
  while (proto && proto !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (descriptor) {
      if (descriptor.get) {
        const value = descriptor.get.call(node);
        if (typeof value === "function") {
          throw new MethodNotFoundError(name);
        }
        return value;
      }
      if ("value" in descriptor) {
        if (typeof descriptor.value === "function") {
          throw new MethodNotFoundError(name);
        }
        return descriptor.value;
      }
    }
    proto = Object.getPrototypeOf(proto);
  }

  // 8. Not found
  throw new MethodNotFoundError(name);
}
