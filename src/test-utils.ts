/**
 * Test helpers — deterministic synchronization primitives.
 *
 * The mock transport delivers messages via queueMicrotask, and all server
 * processing is promise-based. A single setTimeout(r, 0) (one macrotask
 * boundary) is enough to drain all pending microtasks.
 */

import type { Transport } from "./protocol.ts";
import { createMockTransportPair } from "./protocol.ts";
import type {
  RpcClient,
  ClientEvent,
  Context,
  ServerInstance,
  Timers,
} from "./types.ts";

export interface FakeTimers extends Timers {
  /** Number of pending timers. */
  pending(): number;
  /** Fire a timer by id, or the timer with the smallest delay if no id given. */
  fire(id?: number): void;
  /** Fire all pending timers in ascending delay order. */
  fireAll(): void;
  /** Get the smallest delay among pending timers, or undefined if none. */
  getDelay(): number | undefined;
}

/** Create a fake timer implementation for deterministic testing. */
export function fakeTimers(): FakeTimers {
  let nextId = 1;
  const timers = new Map<number, { fn: () => void; ms: number }>();

  return {
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (id: ReturnType<typeof setTimeout>) => {
      timers.delete(id as unknown as number);
    },
    pending: () => timers.size,
    fire: (id?: number) => {
      if (id !== undefined) {
        const t = timers.get(id);
        if (t) {
          timers.delete(id);
          t.fn();
        }
      } else {
        let minId: number | undefined;
        let minMs = Infinity;
        for (const [tid, t] of timers) {
          if (t.ms < minMs) {
            minMs = t.ms;
            minId = tid;
          }
        }
        if (minId !== undefined) {
          const t = timers.get(minId)!;
          timers.delete(minId);
          t.fn();
        }
      }
    },
    fireAll: () => {
      const entries = [...timers.entries()].sort((a, b) => a[1].ms - b[1].ms);
      timers.clear();
      for (const [, t] of entries) {
        t.fn();
      }
    },
    getDelay: () => {
      let minMs: number | undefined;
      for (const t of timers.values()) {
        if (minMs === undefined || t.ms < minMs) minMs = t.ms;
      }
      return minMs;
    },
  };
}

/**
 * Connect a mock client transport to a server. Returns the client-side transport.
 * This mirrors production: the server wires up handlers and sends the schema at
 * connection time.
 */
export function mockConnect(
  server: ServerInstance<any>,
  ctx: Context,
): Transport {
  const [st, ct] = createMockTransportPair();
  server.handle(st, ctx);
  return ct;
}

/** Drain all pending microtasks by waiting one macrotask boundary. */
export function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** One-shot promise wrapper: resolves the next time `event` fires on `client`. */
export function waitForEvent(
  client: RpcClient<ServerInstance<any>>,
  event: ClientEvent,
): Promise<void> {
  return new Promise((resolve) => {
    const handler = (() => {
      client.off(event, handler);
      resolve();
    }) as () => void;
    client.on(event, handler);
  });
}
