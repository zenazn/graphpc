/**
 * Build the indexed Schema array from class metadata.
 * Walks @edge targetType recursively — no instance probing needed.
 */

import { getEdges, isHidden } from "./decorators.ts";
import type { Schema } from "./protocol.ts";
import type { Context } from "./types.ts";

type Constructor = new (...args: any[]) => any;

export interface SchemaResult {
  schema: Schema;
  classIndex: Map<Constructor, number>;
}

/**
 * Build a Schema starting from a root class, filtering out edges
 * hidden for the given context.
 * Walks EdgeMeta.targetType recursively, handling cycles via classToIndex.
 * Types only reachable via hidden edges are omitted entirely.
 * Returns the indexed schema array and a map from constructor → index.
 */
export function buildSchema(
  rootClass: Constructor,
  ctx: Context,
): SchemaResult {
  const schema: Schema = [];
  const classIndex = new Map<Constructor, number>();

  function register(cls: Constructor): number {
    const existing = classIndex.get(cls);
    if (existing !== undefined) return existing;

    // Reserve index before walking children (handles cycles)
    const index = schema.length;
    classIndex.set(cls, index);
    schema.push({ edges: {} }); // placeholder

    const edges = getEdges(cls);
    const edgeRecord: Record<string, number> = {};

    for (const [name, meta] of edges) {
      if (isHidden(cls, name, ctx)) continue;
      edgeRecord[name] = register(meta.targetType);
    }

    schema[index] = { edges: edgeRecord };
    return index;
  }

  register(rootClass);
  return { schema, classIndex };
}
