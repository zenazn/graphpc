import { test, expect } from "bun:test";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { method, edge, getMethods, validateArgs } from "./decorators";
import { Node } from "./types";

// arktype exposes its schema as a *callable* object carrying ~standard.
function callableSchema(): StandardSchemaV1 {
  const fn = ((x: unknown) => x) as unknown as StandardSchemaV1;
  (fn as unknown as Record<string, unknown>)["~standard"] = {
    version: 1,
    vendor: "mock",
    validate: (v: unknown) =>
      typeof v === "string"
        ? { value: v }
        : { issues: [{ message: "expected string" }] },
  };
  return fn;
}

test("callable Standard Schemas (e.g. arktype) are accepted by decorators", async () => {
  class Api extends Node {
    @method(callableSchema())
    async greet(_name: string): Promise<string> {
      return "hi";
    }
  }
  const meta = getMethods(Api).get("greet")!;
  expect(meta.schemas.length).toBe(1);
  expect(await validateArgs(meta.schemas, ["alice"], meta.paramNames)).toEqual([
    "alice",
  ]);
  await expect(
    validateArgs(meta.schemas, [42], meta.paramNames),
  ).rejects.toThrow();
});

test("a callable schema is still rejected as an @edge target", () => {
  expect(() => {
    class Api extends Node {
      // @ts-expect-error a schema is not a valid edge target
      @edge(callableSchema())
      get thing(): Node {
        return this;
      }
    }
    return Api;
  }).toThrow("@edge requires a target class");
});
