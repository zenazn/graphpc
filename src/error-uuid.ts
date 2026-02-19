/**
 * Error UUID tracking — maps error objects to their server-assigned UUIDs.
 */

const errorUuids = new WeakMap<object, string>();

/** @internal — called by the client when receiving an error response with an errorId. */
export function setErrorUuid(error: unknown, errorId: string): void {
  if (error !== null && typeof error === "object") {
    errorUuids.set(error, errorId);
  }
}

/**
 * Retrieve the server-assigned error UUID for a caught error.
 * Returns `null` if the error has no associated UUID.
 */
export function getErrorUuid(error: unknown): string | null {
  if (error !== null && typeof error === "object") {
    return errorUuids.get(error) ?? null;
  }
  return null;
}
