import { expect, test } from "bun:test";
import { edge } from "./decorators";
import { runWithSession, type Session } from "./context";
import { ValidationError } from "./errors";
import { Path, path } from "./node-path";
import { PathArg } from "./path-arg";
import { Node } from "./types";
import type { StandardSchemaV1 } from "@standard-schema/spec";

class Leaf extends Node {}

class Root extends Node {
  // A perfectly ordinary edge that resolves to null (e.g. a missing lookup).
  @edge(Leaf)
  get leaf(): Leaf {
    return null as unknown as Leaf;
  }
}

function session(root: object): Session {
  return {
    ctx: {},
    root,
    nodeCache: new Map(),
    close: () => {},
    signal: new AbortController().signal,
  };
}

test("a Path resolving to null throws ValidationError, not a TypeError", async () => {
  let caught: unknown;
  await runWithSession(session(new Root()), async () => {
    try {
      await new Path(["leaf"], Leaf);
    } catch (e) {
      caught = e;
    }
  });
  expect(caught).toBeInstanceOf(ValidationError);
  expect((caught as ValidationError).message).toContain("null");
});

test("path() rejects an arg deeper than the connection's configured maxDepth", () => {
  class Target extends Node {}
  const validator = path(Target);
  const validate = (v: unknown) =>
    (validator as StandardSchemaV1)["~standard"].validate(
      v,
    ) as StandardSchemaV1.Result<unknown>;

  const s = (maxDepth?: number): Session => ({
    ctx: {},
    root: {},
    nodeCache: new Map(),
    close: () => {},
    signal: new AbortController().signal,
    maxDepth,
  });

  // maxDepth 3 → depth-4 path rejected, depth-3 accepted (no schema → the
  // plausibility walk is skipped, so only the depth check applies).
  runWithSession(s(3), () => {
    const deep = validate(new PathArg(["a", "b", "c", "d"]));
    expect(deep.issues).toBeDefined();
    expect(deep.issues![0]!.message).toContain("maximum depth of 3");

    const ok = validate(new PathArg(["a", "b", "c"]));
    expect(ok.issues).toBeUndefined();
  });

  // No configured maxDepth → falls back to the absolute MAX_PATH_DEPTH (64).
  runWithSession(s(undefined), () => {
    const ok = validate(new PathArg(["a", "b", "c", "d", "e"]));
    expect(ok.issues).toBeUndefined();
  });
});
