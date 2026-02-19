/**
 * SSR client.
 *
 * createSSRClient returns an RpcClient-compatible object whose .root
 * proxy walks the real graph via resolveEdge and records refs/data/calls.
 * Hydration is handled by createClient (see client.ts).
 */

import { runWithSession, type Session } from "./context.ts";
import { resolveEdge, resolveData, resolveGet } from "./resolve.ts";
import { buildSchema } from "./schema.ts";
import type { Schema } from "./protocol.ts";
import type {
  Context,
  RpcClient,
  RpcStub,
  RootOf,
  ServerInstance,
} from "./types.ts";
import type { PathSegments } from "./path.ts";
import { createStub, createDataProxy, classifyPath } from "./proxy.ts";
import type { ProxyBackend } from "./proxy.ts";
import { formatPath, formatValue } from "./format.ts";
import { createSerializer, type SerializerOptions } from "./serialization.ts";

interface SSRRef {
  parentToken: number;
  edge: string;
  args: unknown[];
}

interface SSRDataEntry {
  token: number;
  value: unknown;
}

interface SSRCallEntry {
  token: number;
  method: string;
  args: unknown[];
  result: unknown;
}

export interface SSRClient<S extends ServerInstance<any>> extends RpcClient<S> {
  generateHydrationData(): string;
}

export interface HydrationData {
  refs: Array<[parentToken: number, edge: string, ...args: unknown[]]>;
  data: Array<
    | [token: number, value: unknown]
    | [token: number, method: string, args: unknown[], result: unknown]
  >;
  schema: Schema;
}

/**
 * Create an SSR client for server-side rendering.
 * Returns an RpcClient-compatible object with a .root tracking proxy that
 * lazily records edge traversals and data fetches at await time.
 */
export function createSSRClient<S extends ServerInstance<any>>(
  root: RootOf<S>,
  ctx: Context,
  options?: SerializerOptions,
): SSRClient<S> {
  const serializer = createSerializer(options);

  const refs: SSRRef[] = [];
  const dataEntries: SSRDataEntry[] = [];
  const callEntries: SSRCallEntry[] = [];
  const { schema } = buildSchema(
    (root as object).constructor as new (...args: any[]) => any,
    ctx,
  );

  let nextToken = 1;
  // Promise-based cache for deduplication (handles concurrent awaits)
  const walkPromises = new Map<
    string,
    Promise<{ node: object; token: number }>
  >();
  const nodeCache = new Map<string, Promise<object>>();
  // Dedup sets for data/call entries
  const recordedData = new Set<number>();
  const recordedCalls = new Set<string>();

  const session: Session = {
    ctx,
    root: root as object,
    nodeCache,
    close: () => {},
    reducers: options?.reducers,
    signal: new AbortController().signal,
  };

  function pathKey(path: PathSegments): string {
    return formatPath(path, options?.reducers);
  }

  /**
   * Walk the real graph along edgePath using resolveEdge, assigning tokens
   * and recording refs. Deduplicates via walkPromises cache.
   */
  function walkAndRecord(
    edgePath: PathSegments,
  ): Promise<{ node: object; token: number }> {
    if (edgePath.length === 0) {
      return Promise.resolve({ node: root as object, token: 0 });
    }

    const key = pathKey(edgePath);
    const existing = walkPromises.get(key);
    if (existing) return existing;

    const promise = (async () => {
      const parentPath = edgePath.slice(0, -1);
      const { node: parentNode, token: parentToken } =
        await walkAndRecord(parentPath);

      const seg = edgePath[edgePath.length - 1]!;
      const edgeName = typeof seg === "string" ? seg : seg[0];
      const args = typeof seg === "string" ? [] : (seg.slice(1) as unknown[]);

      const childNode = await resolveEdge(parentNode, edgeName, args, ctx);
      const token = nextToken++;
      refs.push({ parentToken, edge: edgeName, args });

      return { node: childNode, token };
    })();

    walkPromises.set(key, promise);
    return promise;
  }

  const backend: ProxyBackend = {
    resolve(path: PathSegments): Promise<unknown> {
      return runWithSession(session, async () => {
        const { edgePath, terminal } = classifyPath(path, schema);
        const { node, token } = await walkAndRecord(edgePath);

        if (terminal) {
          const result = await resolveGet(
            node,
            terminal.name,
            terminal.args,
            ctx,
          );
          const callKey = `${token}:${terminal.name}:${formatValue(terminal.args, options?.reducers)}`;
          if (!recordedCalls.has(callKey)) {
            recordedCalls.add(callKey);
            callEntries.push({
              token,
              method: terminal.name,
              args: terminal.args,
              result,
            });
          }
          return result;
        } else {
          const data = resolveData(node, ctx);
          if (!recordedData.has(token)) {
            recordedData.add(token);
            dataEntries.push({ token, value: data });
          }
          return createDataProxy(backend, edgePath, data);
        }
      });
    },
  };

  const proxy = createStub(backend, []);

  return {
    root: proxy as RpcStub<RootOf<S>>,
    ready: Promise.resolve(undefined as unknown as void),
    on() {},
    off() {},
    hydrate() {},
    hydrateString() {},
    endHydration() {},
    reconnect() {},
    close() {},
    generateHydrationData(): string {
      const hydration: HydrationData = {
        refs: refs.map((r) =>
          r.args.length > 0
            ? [r.parentToken, r.edge, ...r.args]
            : [r.parentToken, r.edge],
        ),
        data: [
          ...dataEntries.map((d) => [d.token, d.value] as [number, unknown]),
          ...callEntries.map(
            (c) =>
              [c.token, c.method, c.args, c.result] as [
                number,
                string,
                unknown[],
                unknown,
              ],
          ),
        ],
        schema,
      };
      return serializer.stringify(hydration);
    },
  };
}
