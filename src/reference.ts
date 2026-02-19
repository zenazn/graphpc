/**
 * Reference<T> — a plain data holder representing a resolved graph node.
 * Separated from ref.ts so that modules like serialization.ts can use it
 * without pulling in the server-only AsyncLocalStorage dependency.
 */

import type { PathSegments } from "./path.ts";

export class Reference<T> {
  constructor(
    public readonly path: PathSegments,
    public readonly data: Record<string, unknown>,
  ) {}
}

export function isReference(value: unknown): value is Reference<unknown> {
  return value instanceof Reference;
}
