import { test, expect } from "bun:test";
import { z } from "zod";
import {
  edge,
  method,
  hidden,
  getEdges,
  getMethods,
  getHidden,
  isHidden,
} from "./decorators.ts";
import { Node } from "./types.ts";

class UsersStub extends Node {}

test("@edge on getter with target class", () => {
  class Api {
    @edge(UsersStub)
    get users(): UsersStub {
      return new UsersStub();
    }
  }

  const edges = getEdges(Api);
  expect(edges.size).toBe(1);
  expect(edges.get("users")).toMatchObject({
    name: "users",
    kind: "getter",
    targetType: UsersStub,
    schemas: [],
  });
});

test("@edge on method with target class and schema", () => {
  class Item extends Node {}

  class Api {
    @edge(Item, z.string())
    get(id: string): Item {
      return new Item();
    }
  }

  const edges = getEdges(Api);
  expect(edges.size).toBe(1);
  const meta = edges.get("get")!;
  expect(meta.kind).toBe("method");
  expect(meta.targetType).toBe(Item);
  expect(meta.schemas.length).toBe(1);
  expect(meta.paramNames).toEqual(["id"]);
});

test("@method with no schema", () => {
  class Api {
    @method
    async list(): Promise<string[]> {
      return [];
    }
  }

  const methods = getMethods(Api);
  expect(methods.size).toBe(1);
  expect(methods.get("list")).toMatchObject({
    name: "list",
    schemas: [],
  });
});

test("@method with schema", () => {
  class Api {
    @method(z.string().email())
    async updateEmail(email: string): Promise<void> {}
  }

  const methods = getMethods(Api);
  const meta = methods.get("updateEmail")!;
  expect(meta.schemas.length).toBe(1);
  expect(meta.paramNames).toEqual(["email"]);
});

test("multiple edges on same class", () => {
  class UsersType extends Node {}
  class PostsType extends Node {}

  class Api {
    @edge(UsersType)
    get users(): UsersType {
      return new UsersType();
    }

    @edge(PostsType)
    get posts(): PostsType {
      return new PostsType();
    }
  }

  const edges = getEdges(Api);
  expect(edges.size).toBe(2);
  expect(edges.has("users")).toBe(true);
  expect(edges.has("posts")).toBe(true);
});

// -- @hidden tests --

test("@hidden stores predicate in metadata via getHidden", () => {
  const predicate = () => true;
  class Api {
    @hidden(predicate)
    @edge(UsersStub)
    get users(): UsersStub {
      return new UsersStub();
    }
  }

  const map = getHidden(Api);
  expect(map.size).toBe(1);
  expect(map.get("users")).toBe(predicate);
});

test("isHidden returns true when predicate returns true", () => {
  class Api {
    @hidden(() => true)
    @edge(UsersStub)
    get users(): UsersStub {
      return new UsersStub();
    }
  }

  expect(isHidden(Api, "users", {})).toBe(true);
});

test("@hidden works on @method", () => {
  class Api {
    @hidden(() => true)
    @method
    async secret(): Promise<string> {
      return "hidden";
    }
  }

  const map = getHidden(Api);
  expect(map.size).toBe(1);
  expect(map.has("secret")).toBe(true);
  expect(isHidden(Api, "secret", {})).toBe(true);
});

test("predicate receives undefined as this (not the node)", () => {
  let receivedThis: unknown = "not-called";
  class Api {
    @hidden(function (this: unknown) {
      receivedThis = this;
      return false;
    })
    @edge(UsersStub)
    get users(): UsersStub {
      return new UsersStub();
    }
  }

  isHidden(Api, "users", {});
  expect(receivedThis).toBeUndefined();
});

// -- Inheritance tests --

test("getEdges returns inherited edges from parent class", () => {
  class Child extends Node {}
  class Base {
    @edge(Child)
    get child(): Child {
      return new Child();
    }
  }
  class Derived extends Base {}

  const edges = getEdges(Derived);
  expect(edges.size).toBe(1);
  expect(edges.get("child")).toMatchObject({
    name: "child",
    kind: "getter",
    targetType: Child,
  });
});

test("getMethods returns inherited methods from parent class", () => {
  class Base {
    @method
    async baseMethod(): Promise<string> {
      return "base";
    }
  }
  class Derived extends Base {}

  const methods = getMethods(Derived);
  expect(methods.size).toBe(1);
  expect(methods.get("baseMethod")).toMatchObject({ name: "baseMethod" });
});

test("derived override takes precedence over parent", () => {
  class ChildA extends Node {}
  class ChildB extends Node {}
  class Base {
    @edge(ChildA)
    get item(): ChildA {
      return new ChildA();
    }
  }
  class Derived extends Base {
    @edge(ChildB)
    override get item(): ChildB {
      return new ChildB();
    }
  }

  const edges = getEdges(Derived);
  expect(edges.get("item")!.targetType).toBe(ChildB);
});

test("parent metadata not polluted by derived decorators", () => {
  class ChildA extends Node {}
  class ChildB extends Node {}
  class Base {
    @edge(ChildA)
    get baseEdge(): ChildA {
      return new ChildA();
    }
  }
  class Derived extends Base {
    @edge(ChildB)
    get derivedEdge(): ChildB {
      return new ChildB();
    }
  }

  const baseEdges = getEdges(Base);
  expect(baseEdges.size).toBe(1);
  expect(baseEdges.has("baseEdge")).toBe(true);
  expect(baseEdges.has("derivedEdge")).toBe(false);
});

test("isHidden respects inherited @hidden predicates", () => {
  class Base {
    @hidden(() => true)
    @edge(UsersStub)
    get users(): UsersStub {
      return new UsersStub();
    }
  }
  class Derived extends Base {}

  expect(isHidden(Derived, "users", {})).toBe(true);
});

// -- paramNames extraction tests --

test("paramNames extracts simple param names", () => {
  class Api {
    @method(z.string(), z.number())
    async update(name: string, age: number): Promise<void> {}
  }

  const meta = getMethods(Api).get("update")!;
  expect(meta.paramNames).toEqual(["name", "age"]);
});

test("paramNames handles no parameters", () => {
  class Api {
    @method
    async ping(): Promise<void> {}
  }

  const meta = getMethods(Api).get("ping")!;
  expect(meta.paramNames).toEqual([]);
});

test("paramNames handles rest parameters", () => {
  class Api {
    @method(z.string())
    async log(...messages: string[]): Promise<void> {}
  }

  const meta = getMethods(Api).get("log")!;
  expect(meta.paramNames).toEqual(["messages"]);
});

test("paramNames handles destructured parameter with fallback name", () => {
  class Api {
    @method(z.object({ a: z.number(), b: z.number() }))
    async sum({ a, b }: { a: number; b: number }): Promise<number> {
      return a + b;
    }
  }

  const meta = getMethods(Api).get("sum")!;
  expect(meta.paramNames).toEqual(["arg0"]);
});

test("paramNames handles parenthesized default values", () => {
  class Api {
    @method(z.number(), z.number())
    async calc(x: number = 1 + 2, y: number = 3): Promise<number> {
      return x + y;
    }
  }

  const meta = getMethods(Api).get("calc")!;
  expect(meta.paramNames).toEqual(["x", "y"]);
});

test("paramNames handles mixed param styles", () => {
  class Api {
    @method(z.string(), z.object({ x: z.number() }), z.number(), z.string())
    async mixed(
      a: string,
      { x }: { x: number },
      c: number = 1 + 2,
      ...rest: string[]
    ): Promise<void> {}
  }

  const meta = getMethods(Api).get("mixed")!;
  expect(meta.paramNames).toEqual(["a", "arg1", "c", "rest"]);
});

// -- paramNames edge cases: strings, templates, comments in defaults --

test("paramNames handles string literal with parentheses in default", () => {
  class Api {
    @method(z.string(), z.string())
    async greet(x: string = "(hello)", y: string): Promise<void> {}
  }

  const meta = getMethods(Api).get("greet")!;
  expect(meta.paramNames).toEqual(["x", "y"]);
});

test("paramNames handles single-quoted string with brackets in default", () => {
  class Api {
    @method(z.string(), z.number())
    async process(sep: string = "({[", n: number): Promise<void> {}
  }

  const meta = getMethods(Api).get("process")!;
  expect(meta.paramNames).toEqual(["sep", "n"]);
});

test("paramNames handles template literal in default", () => {
  class Api {
    @method(z.string(), z.number())
    async fmt(prefix: string = `(${1 + 2})`, count: number): Promise<void> {}
  }

  const meta = getMethods(Api).get("fmt")!;
  expect(meta.paramNames).toEqual(["prefix", "count"]);
});

test("paramNames handles escaped quotes in string default", () => {
  class Api {
    @method(z.string(), z.string())
    async escape(a: string = 'he said "(hi)"', b: string): Promise<void> {}
  }

  const meta = getMethods(Api).get("escape")!;
  expect(meta.paramNames).toEqual(["a", "b"]);
});

// -- validateArgs excess arguments tests --

import { validateArgs } from "./decorators.ts";
import { ValidationError } from "./errors.ts";

test("validateArgs throws ValidationError when args exceed schemas", async () => {
  const schema = z.string();
  try {
    await validateArgs([schema], ["valid", "extra"], ["name"]);
    expect.unreachable("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).message).toContain(
      "Expected 1 argument, got 2",
    );
  }
});

test("validateArgs allows fewer args than schemas (optional params)", async () => {
  const schema1 = z.string();
  const schema2 = z.string().optional();
  const result = await validateArgs([schema1, schema2], ["hello"], ["a", "b"]);
  expect(result[0]).toBe("hello");
  expect(result[1]).toBeUndefined();
});

test("validateArgs with zero schemas rejects any args", async () => {
  try {
    await validateArgs([], ["unexpected"], []);
    expect.unreachable("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).message).toContain(
      "Expected 0 arguments, got 1",
    );
  }
});

test("@edge throws when target does not extend Node", () => {
  class NotANode {}

  expect(() => {
    class Api {
      @edge(NotANode)
      get child(): NotANode {
        return new NotANode();
      }
    }
  }).toThrow("@edge target NotANode must extend Node");
});
