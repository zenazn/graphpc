/**
 * Path<T> — a thenable reference to a graph node.
 *
 * On the server, `await path` walks the graph to resolve a live node.
 * Over the wire, it serializes as `NodePath` (just the segments).
 * On the client, it revives as a stub.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { PathArg } from "./path-arg.ts";
import type { PathSegments } from "./path.ts";
import { getSession, tryGetSession } from "./context.ts";
import { walkPath } from "./ref.ts";
import { ValidationError } from "./errors.ts";
import { Node, type pathTag } from "./types.ts";

const MAX_PATH_DEPTH = 64;

export class Path<T extends Node> extends PathArg implements PromiseLike<T> {
  declare readonly [pathTag]: T;
  readonly #expectedType: new (...args: any[]) => T;
  #resolved: Promise<T> | undefined;

  constructor(segments: PathSegments, expectedType: new (...args: any[]) => T) {
    super(segments);
    if (segments.length > MAX_PATH_DEPTH) {
      throw new ValidationError([
        { message: `Path exceeds maximum depth of ${MAX_PATH_DEPTH} segments` },
      ]);
    }
    this.#expectedType = expectedType;
  }

  then<R1 = T, R2 = never>(
    onfulfilled?: ((v: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((e: any) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    this.#resolved ??= this.#walk();
    return this.#resolved.then(onfulfilled, onrejected);
  }

  async #walk(): Promise<T> {
    const session = getSession();
    const node = await walkPath(
      session.root,
      this.segments,
      session.nodeCache,
      session.reducers,
      session.ctx,
    );
    if (!(node instanceof this.#expectedType)) {
      throw new ValidationError([
        {
          message: `Path resolved to ${node.constructor.name}, expected ${this.#expectedType.name}`,
        },
      ]);
    }
    return node as T;
  }
}

/**
 * Standard Schema that validates a PathArg and coerces it to Path<T>.
 * Use with `@method(path(Post))` to receive typed path arguments.
 */
export function path<T extends Node>(
  cls: new (...args: any[]) => T,
): StandardSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor: "graphpc",
      validate(input: unknown) {
        if (!(input instanceof PathArg)) {
          return { issues: [{ message: "Expected a path reference" }] };
        }

        if (input.segments.length > MAX_PATH_DEPTH) {
          return {
            issues: [
              {
                message: `Path exceeds maximum depth of ${MAX_PATH_DEPTH} segments`,
              },
            ],
          };
        }

        // Plausibility check: walk schema to verify path could lead to cls
        const session = tryGetSession();
        if (session?.schema && session?.classIndex) {
          const targetIndex = session.classIndex.get(cls);
          if (targetIndex === undefined) {
            return {
              issues: [
                { message: `${cls.name} is not reachable in the graph` },
              ],
            };
          }

          let typeIndex = 0;
          for (const seg of input.segments) {
            const name = typeof seg === "string" ? seg : seg[0];
            const nodeSchema = session.schema[typeIndex];
            if (!nodeSchema) {
              return {
                issues: [{ message: `Invalid path at "${name}"` }],
              };
            }
            const next = nodeSchema.edges[name];
            if (next === undefined) {
              return { issues: [{ message: `"${name}" is not an edge` }] };
            }
            typeIndex = next;
          }

          if (typeIndex !== targetIndex) {
            // Resolve the name of the type the path actually leads to
            let actualName = "unknown";
            for (const [ctor, idx] of session.classIndex) {
              if (idx === typeIndex) {
                actualName = (ctor as Function).name;
                break;
              }
            }
            return {
              issues: [
                {
                  message: `Path leads to ${actualName}, expected ${cls.name}`,
                },
              ],
            };
          }
        }

        // Coerce PathArg → Path<T>
        return { value: new Path(input.segments, cls) };
      },
    },
  };
}
