/**
 * Type-level tests for the Transport interface.
 *
 * This file is NOT executed at runtime. It is checked by `bun typecheck`
 * (tsc --noEmit) and excluded from the build (tsconfig.build.json excludes
 * src/**\/*.typetest.ts).
 */

import type { Transport } from "./protocol";

// ---------------------------------------------------------------------------
// docs/internals.md ("Transport Interface") promises that the standard Web
// WebSocket structurally satisfies Transport, so it can be passed directly to
// server.handle() or returned from createClient()'s transport factory. In
// particular, its readonly numeric `bufferedAmount` property must be
// assignable to Transport's `bufferedAmount?: number | (() => number)`.
// ---------------------------------------------------------------------------

declare const ws: WebSocket;
const _t: Transport = ws;
void _t;

// A function-shaped bufferedAmount (as the built-in Bun adapter provides) must
// keep working too.
declare const fnTransport: {
  send(data: string): void;
  close(): void;
  bufferedAmount: () => number;
  addEventListener(type: string, listener: (event: never) => void): void;
  removeEventListener(type: string, listener: (event: never) => void): void;
};
const _t2: Transport = fnTransport;
void _t2;
