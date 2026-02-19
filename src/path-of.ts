/**
 * pathOf() — extract a PathArg from a client stub or data proxy.
 *
 * Used on the client to capture a stub's navigation path as a value
 * that can be sent to the server as a method argument.
 */

import { PathArg } from "./path-arg.ts";
import { STUB_PATH } from "./proxy.ts";

export function pathOf(stub: any): PathArg {
  const segments = stub?.[STUB_PATH];
  if (!segments) {
    throw new Error("pathOf() requires a stub or data proxy");
  }
  return new PathArg(segments);
}
