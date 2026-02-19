/**
 * Types for server operation events.
 *
 * The `operation` event uses a wrapping/middleware pattern that preserves
 * async context — so OTel spans created inside a handler are automatically
 * parents of any user-instrumented calls (fetch, DB, etc.).
 */

export interface OperationInfo {
  /** The operation type. */
  op: "edge" | "get" | "data";
  /** Edge name, method/property name, or "data". */
  name: string;
  /** Human-readable graph path, e.g. "root.posts.get(\"42\")". */
  path: string;
  /** Arguments passed to the operation. */
  args: readonly unknown[];
  /** Fires on timeout or connection close. */
  signal: AbortSignal;
  /** Internal message ID for correlation. */
  messageId: number;
}

export interface OperationResult {
  /** Present if the operation errored (pre-redaction). */
  error?: unknown;
}
