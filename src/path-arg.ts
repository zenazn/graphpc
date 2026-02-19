/**
 * PathArg — a lightweight wrapper around path segments.
 *
 * Created on the client by `pathOf()`, and sent over the wire as a `NodePath`.
 * On the server, `Path<T>` extends this class, so `instanceof PathArg` catches both.
 */

import type { PathSegments } from "./path.ts";

export class PathArg {
  constructor(readonly segments: PathSegments) {}
}
