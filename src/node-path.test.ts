import { expect, test } from "bun:test";
import { edge } from "./decorators";
import { runWithSession, type Session } from "./context";
import { ValidationError } from "./errors";
import { Path } from "./node-path";
import { Node } from "./types";

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
