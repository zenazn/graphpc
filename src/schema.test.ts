import { test, expect } from "bun:test";
import { z } from "zod";
import { edge, method, hidden } from "./decorators.ts";
import { buildSchema } from "./schema.ts";
import { Node } from "./types.ts";

class Post extends Node {
  title = "Hello";
}

class PostsService extends Node {
  @edge(Post, z.string())
  get(id: string): Post {
    return new Post();
  }

  @method
  async list(): Promise<string[]> {
    return [];
  }
}

class User extends Node {
  name = "Alice";

  @method
  async updateEmail(email: string): Promise<void> {}

  @edge(PostsService)
  get posts(): PostsService {
    return new PostsService();
  }
}

class Api extends Node {
  @edge(User)
  get users(): User {
    return new User();
  }
}

test("buildSchema creates indexed schema from class metadata", () => {
  const { schema, classIndex } = buildSchema(Api, {});

  // Api is index 0
  expect(classIndex.get(Api)).toBe(0);
  // User is index 1
  expect(classIndex.get(User)).toBe(1);
  // PostsService is index 2
  expect(classIndex.get(PostsService)).toBe(2);
  // Post is index 3
  expect(classIndex.get(Post)).toBe(3);

  // Api has one edge: users → User (index 1)
  expect(schema[0]).toEqual({ edges: { users: 1 } });
  // User has one edge: posts → PostsService (index 2)
  expect(schema[1]).toEqual({ edges: { posts: 2 } });
  // PostsService has one edge: get → Post (index 3)
  expect(schema[2]).toEqual({ edges: { get: 3 } });
  // Post has no edges
  expect(schema[3]).toEqual({ edges: {} });
});

test("buildSchema handles cycles", () => {
  class NodeA extends Node {
    @edge(NodeA)
    get self(): NodeA {
      return new NodeA();
    }
  }

  const { schema, classIndex } = buildSchema(NodeA, {});
  expect(classIndex.get(NodeA)).toBe(0);
  // Self-referential edge
  expect(schema[0]).toEqual({ edges: { self: 0 } });
  expect(schema.length).toBe(1);
});

test("buildSchema removes hidden edges when predicate returns true", () => {
  class Secret extends Node {}
  class Public extends Node {}

  class Root extends Node {
    @hidden(() => true)
    @edge(Secret)
    get secret(): Secret {
      return new Secret();
    }

    @edge(Public)
    get pub(): Public {
      return new Public();
    }
  }

  const { schema, classIndex } = buildSchema(Root, {});
  // Root at 0, Public at 1 — Secret not present
  expect(classIndex.has(Root)).toBe(true);
  expect(classIndex.has(Public)).toBe(true);
  expect(classIndex.has(Secret)).toBe(false);
  expect(schema[0]).toEqual({ edges: { pub: 1 } });
});

test("buildSchema keeps edges when predicate returns false", () => {
  class Visible extends Node {}

  class Root extends Node {
    @hidden(() => false)
    @edge(Visible)
    get vis(): Visible {
      return new Visible();
    }
  }

  const { schema, classIndex } = buildSchema(Root, {});
  expect(classIndex.has(Visible)).toBe(true);
  expect(schema[0]).toEqual({ edges: { vis: 1 } });
});

test("buildSchema omits unreachable types entirely (shorter array)", () => {
  class Deep extends Node {}
  class OnlyViaHidden extends Node {
    @edge(Deep)
    get deep(): Deep {
      return new Deep();
    }
  }
  class AlwaysVisible extends Node {}

  class Root extends Node {
    @hidden(() => true)
    @edge(OnlyViaHidden)
    get secretBranch(): OnlyViaHidden {
      return new OnlyViaHidden();
    }

    @edge(AlwaysVisible)
    get pub(): AlwaysVisible {
      return new AlwaysVisible();
    }
  }

  const { schema, classIndex } = buildSchema(Root, {});
  // Only Root and AlwaysVisible should appear
  expect(schema.length).toBe(2);
  expect(classIndex.has(OnlyViaHidden)).toBe(false);
  expect(classIndex.has(Deep)).toBe(false);
});

test("types reachable via other visible edges still appear", () => {
  class Shared extends Node {}

  class Root extends Node {
    @hidden(() => true)
    @edge(Shared)
    get hiddenPath(): Shared {
      return new Shared();
    }

    @edge(Shared)
    get visiblePath(): Shared {
      return new Shared();
    }
  }

  const { schema, classIndex } = buildSchema(Root, {});
  // Shared is still reachable through visiblePath
  expect(classIndex.has(Shared)).toBe(true);
  // hiddenPath should not be in the edges
  expect(schema[0]!.edges).not.toHaveProperty("hiddenPath");
  expect(schema[0]!.edges).toHaveProperty("visiblePath");
});
