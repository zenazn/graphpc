/**
 * pathOf() — extract a PathArg from a client stub or data proxy.
 *
 * Used on the client to capture a stub's navigation path as a value
 * that can be sent to the server as a method argument.
 */

import { PathArg } from "./path-arg";
import { STUB_PATH } from "./proxy";

export function pathOf(stub: unknown): PathArg {
  const segments = (stub as { [STUB_PATH]?: unknown } | null | undefined)?.[
    STUB_PATH
  ];
  if (!Array.isArray(segments)) {
    throw new Error("pathOf() requires a stub or data proxy");
  }
  return new PathArg(segments);
}
