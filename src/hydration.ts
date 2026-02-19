/**
 * HydrationCache — extracted from client.ts.
 *
 * Manages the hydration cache built from SSR-collected data.
 * Allows the client to serve cached data/calls before the transport
 * is ready, with an inactivity timeout that drops the cache
 * after the last lookup's microtask resolves.
 */

import { formatPath, formatValue } from "./format.ts";
import type { Schema } from "./protocol.ts";
import type { PathSegments, PathSegment } from "./path.ts";
import type { HydrationData } from "./ssr.ts";
import { type Timers, defaultTimers } from "./types.ts";

type Reducers = Record<string, (value: unknown) => false | unknown[]>;

export type LookupResult = { hit: true; value: unknown } | { hit: false };

/**
 * Shallow sanity check for hydration data shape.
 * Catches programmer mistakes (wrong variable, missing serialize step, etc.)
 * without deeply validating every entry.
 */
export function validateHydrationData(value: unknown): HydrationData {
  if (
    value == null ||
    typeof value !== "object" ||
    !Array.isArray((value as any).refs) ||
    !Array.isArray((value as any).data) ||
    !Array.isArray((value as any).schema)
  ) {
    throw new TypeError(
      `Expected hydration data with refs, data, and schema arrays, got ${typeof value}`,
    );
  }
  return value as HydrationData;
}

export class HydrationCache {
  private active = false;
  private pathToToken: Map<string, number> | undefined;
  private dataCache: Map<number, unknown> | undefined;
  private callCache: Map<string, unknown> | undefined;
  private inFlight = 0;
  private inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly timeout: number;
  private readonly timers: Timers;
  private readonly reducers: Reducers | undefined;

  constructor(options: {
    timeout: number;
    reducers?: Reducers;
    timers?: Partial<Timers>;
  }) {
    this.timeout = options.timeout;
    this.reducers = options.reducers;
    const defaults = defaultTimers();
    this.timers = {
      setTimeout: options.timers?.setTimeout ?? defaults.setTimeout,
      clearTimeout: options.timers?.clearTimeout ?? defaults.clearTimeout,
    };
  }

  /**
   * Build internal maps from parsed hydration data.
   * Returns the schema embedded in the hydration data.
   */
  activate(parsed: HydrationData): Schema {
    this.active = true;

    const tokenPaths = new Map<number, PathSegments>();
    this.pathToToken = new Map<string, number>();
    tokenPaths.set(0, []);
    this.pathToToken.set("root", 0);

    for (let i = 0; i < parsed.refs.length; i++) {
      const ref = parsed.refs[i]!;
      const token = i + 1;
      const [parentToken, edge, ...args] = ref;
      const parentPath = tokenPaths.get(parentToken) ?? [];
      const segment: PathSegment = args.length > 0 ? [edge, ...args] : edge;
      const fullPath = [...parentPath, segment];
      tokenPaths.set(token, fullPath);
      this.pathToToken.set(formatPath(fullPath, this.reducers), token);
    }

    this.dataCache = new Map<number, unknown>();
    this.callCache = new Map<string, unknown>();

    for (const entry of parsed.data) {
      if (entry.length === 2) {
        this.dataCache.set(entry[0] as number, entry[1]);
      } else if (entry.length === 4) {
        const [token, method, args, result] = entry;
        const key = `${token}:${method}:${formatValue(args, this.reducers)}`;
        this.callCache.set(key, result);
      }
    }

    return parsed.schema;
  }

  isActive(): boolean {
    return this.active;
  }

  /**
   * Look up a cached value.
   *
   * @param edgePathSegmentsKey - Pre-serialized path key (via the stringify option)
   * @param terminal - The terminal method call, or null for data fetches
   * @returns Discriminated union: { hit: true, value } or { hit: false }
   */
  lookup(
    edgePathSegmentsKey: string,
    terminal: { name: string; args: unknown[] } | null,
  ): LookupResult {
    if (
      !this.active ||
      !this.pathToToken ||
      !this.dataCache ||
      !this.callCache
    ) {
      return { hit: false };
    }

    const token = this.pathToToken.get(edgePathSegmentsKey);
    if (token === undefined) return { hit: false };

    if (terminal) {
      const key = `${token}:${terminal.name}:${formatValue(terminal.args, this.reducers)}`;
      const cached = this.callCache.get(key);
      if (cached !== undefined) {
        this.trackInFlight();
        return { hit: true, value: cached };
      }

      // Property read: cross-reference full-node data cache
      // (mirrors the liveDataCache check in the live client path)
      if (terminal.args.length === 0) {
        const nodeData = this.dataCache.get(token);
        if (
          nodeData != null &&
          typeof nodeData === "object" &&
          terminal.name in (nodeData as Record<string, unknown>)
        ) {
          this.trackInFlight();
          return {
            hit: true,
            value: (nodeData as Record<string, unknown>)[terminal.name],
          };
        }
      }
    } else {
      const cached = this.dataCache.get(token);
      if (cached !== undefined) {
        this.trackInFlight();
        return { hit: true, value: cached };
      }
    }

    return { hit: false };
  }

  /** Drop the cache immediately. Idempotent. */
  drop(): void {
    this.active = false;
    this.pathToToken = undefined;
    this.dataCache = undefined;
    this.callCache = undefined;
    if (this.inactivityTimer !== undefined) {
      this.timers.clearTimeout(this.inactivityTimer);
      this.inactivityTimer = undefined;
    }
  }

  private trackInFlight(): void {
    this.inFlight++;
    if (this.inactivityTimer !== undefined) {
      this.timers.clearTimeout(this.inactivityTimer);
      this.inactivityTimer = undefined;
    }
    Promise.resolve().then(() => {
      this.inFlight--;
      this.onInFlightDrop();
    });
  }

  private onInFlightDrop(): void {
    if (!this.active || this.inFlight > 0) return;
    this.inactivityTimer = this.timers.setTimeout(
      () => this.drop(),
      this.timeout,
    );
  }
}
