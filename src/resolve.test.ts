import { test, expect } from "bun:test";
import { z } from "zod";
import { edge, method, hidden } from "./decorators.ts";
import { resolveEdge, resolveData, resolveGet } from "./resolve.ts";
import {
  EdgeNotFoundError,
  MethodNotFoundError,
  ValidationError,
} from "./errors.ts";
import { Node } from "./types.ts";

class User extends Node {
  name: string;
  email: string;

  constructor(name: string, email: string) {
    super();
    this.name = name;
    this.email = email;
  }

  @method(z.string().email())
  async updateEmail(email: string): Promise<void> {
    this.email = email;
  }
}

class UsersService extends Node {
  @edge(User, z.string())
  get(id: string): User {
    return new User("Alice", "alice@example.com");
  }

  @method
  async list(): Promise<string[]> {
    return ["alice", "bob"];
  }
}

class Api extends Node {
  @edge(UsersService)
  get users(): UsersService {
    return new UsersService();
  }
}

test("resolveEdge: getter edge", async () => {
  const api = new Api();
  const result = await resolveEdge(api, "users", [], {});
  expect(result).toBeInstanceOf(UsersService);
});

test("resolveEdge: method edge with args", async () => {
  const users = new UsersService();
  const result = await resolveEdge(users, "get", ["42"], {});
  expect(result).toBeInstanceOf(User);
  expect((result as User).name).toBe("Alice");
});

test("resolveEdge: missing edge throws", async () => {
  const api = new Api();
  expect(resolveEdge(api, "nonexistent", [], {})).rejects.toBeInstanceOf(
    EdgeNotFoundError,
  );
});

test("resolveEdge: validation error", async () => {
  const users = new UsersService();
  expect(resolveEdge(users, "get", [123], {})).rejects.toBeInstanceOf(
    ValidationError,
  );
});

test("resolveData: extracts own properties", () => {
  const user = new User("Alice", "alice@example.com");
  const data = resolveData(user, {});
  expect(data).toEqual({ name: "Alice", email: "alice@example.com" });
});

test("resolveData: includes getter values from class", () => {
  class TestNode {
    first = "Alice";
    last = "Smith";
    get fullName(): string {
      return `${this.first} ${this.last}`;
    }
  }
  const node = new TestNode();
  const data = resolveData(node, {});
  expect(data).toEqual({
    first: "Alice",
    last: "Smith",
    fullName: "Alice Smith",
  });
});

test("resolveData: includes inherited getter values from superclass", () => {
  class Base {
    get computed(): number {
      return 42;
    }
  }
  class Derived extends Base {
    name = "test";
  }
  const derived = new Derived();
  const data = resolveData(derived, {});
  expect(data).toEqual({ name: "test", computed: 42 });
});

test("resolveData: excludes @edge getters", () => {
  class Child extends Node {}
  class Parent {
    name = "parent";
    @edge(Child)
    get child(): Child {
      return new Child();
    }
  }
  const parent = new Parent();
  const data = resolveData(parent, {});
  expect(data).toEqual({ name: "parent" });
  expect(data).not.toHaveProperty("child");
});

test("resolveData: excludes @method functions", () => {
  class TestNode {
    value = 1;
    @method
    async doStuff(): Promise<string> {
      return "stuff";
    }
  }
  const node = new TestNode();
  const data = resolveData(node, {});
  expect(data).toEqual({ value: 1 });
  expect(data).not.toHaveProperty("doStuff");
});

test("resolveData: excludes @hidden members", () => {
  class TestNode {
    name = "visible";
    @hidden(() => true)
    @method
    async secret(): Promise<string> {
      return "hidden";
    }
    get computed(): number {
      return 99;
    }
  }
  const node = new TestNode();
  const data = resolveData(node, {});
  expect(data).toEqual({ name: "visible", computed: 99 });
});

test("resolveData: excludes @hidden own properties", () => {
  class TestNode {
    visible = "yes";
    secret = "top-secret";
  }
  // Mark "secret" as hidden
  hidden(() => true)(
    TestNode.prototype,
    "secret",
    Object.getOwnPropertyDescriptor(TestNode.prototype, "secret") || {
      value: undefined,
      writable: true,
      enumerable: true,
      configurable: true,
    },
  );

  const node = new TestNode();
  const data = resolveData(node, {});
  expect(data).toEqual({ visible: "yes" });
  expect(data).not.toHaveProperty("secret");
});

test("resolveData: excludes getters returning functions", () => {
  class TestNode {
    name = "test";
    get action(): () => void {
      return () => {};
    }
  }
  const node = new TestNode();
  const data = resolveData(node, {});
  expect(data).toEqual({ name: "test" });
  expect(data).not.toHaveProperty("action");
});

test("resolveData: own properties shadow prototype getters", () => {
  class WithGetter {
    get label(): string {
      return "from-getter";
    }
  }
  // Simulate an own property that shadows a getter by setting it directly
  const node = new WithGetter();
  Object.defineProperty(node, "label", {
    value: "from-own",
    enumerable: true,
    writable: true,
    configurable: true,
  });
  const data = resolveData(node, {});
  expect(data.label).toBe("from-own");
});

test("resolveGet: invokes method", async () => {
  const users = new UsersService();
  const result = await resolveGet(users, "list", [], {});
  expect(result).toEqual(["alice", "bob"]);
});

test("resolveGet: validates args", async () => {
  const user = new User("Alice", "alice@example.com");
  expect(
    resolveGet(user, "updateEmail", ["not-an-email"], {}),
  ).rejects.toBeInstanceOf(ValidationError);
});

test("resolveGet: missing method throws", async () => {
  const user = new User("Alice", "alice@example.com");
  expect(resolveGet(user, "nonexistent", [], {})).rejects.toBeInstanceOf(
    MethodNotFoundError,
  );
});

test("resolveGet: returns own property value when not a @method", async () => {
  const user = new User("Alice", "alice@example.com");
  const name = await resolveGet(user, "name", [], {});
  expect(name).toBe("Alice");
});

test("resolveGet: getter on superclass returns value via fallback", async () => {
  class Base {
    get computed(): number {
      return 42;
    }
  }
  class Derived extends Base {
    name = "test";
  }

  const derived = new Derived();
  const result = await resolveGet(derived, "computed", [], {});
  expect(result).toBe(42);
});

test("resolveGet: undecorated method throws MethodNotFoundError", async () => {
  class TestNode {
    doStuff(): string {
      return "nope";
    }
  }

  const node = new TestNode();
  expect(resolveGet(node, "doStuff", [], {})).rejects.toBeInstanceOf(
    MethodNotFoundError,
  );
});

test("resolveGet: Object.prototype builtins throw MethodNotFoundError", async () => {
  class TestNode {
    name = "test";
  }

  const node = new TestNode();
  expect(resolveGet(node, "toString", [], {})).rejects.toBeInstanceOf(
    MethodNotFoundError,
  );
  expect(resolveGet(node, "constructor", [], {})).rejects.toBeInstanceOf(
    MethodNotFoundError,
  );
});

// -- @hidden resolve tests --

test("resolveEdge throws EdgeNotFoundError for hidden edge", async () => {
  class Secret extends Node {}
  class Root {
    @hidden(() => true)
    @edge(Secret)
    get secret(): Secret {
      return new Secret();
    }
  }

  const root = new Root();
  expect(resolveEdge(root, "secret", [], {})).rejects.toBeInstanceOf(
    EdgeNotFoundError,
  );
});

test("resolveGet throws MethodNotFoundError for hidden method", async () => {
  class TestNode {
    @hidden(() => true)
    @method
    async secret(): Promise<string> {
      return "hidden";
    }
  }

  const node = new TestNode();
  expect(resolveGet(node, "secret", [], {})).rejects.toBeInstanceOf(
    MethodNotFoundError,
  );
});

// -- Inheritance tests --

test("resolveEdge works on inherited getter edge", async () => {
  class Child extends Node {}
  class Base {
    @edge(Child)
    get child(): Child {
      return new Child();
    }
  }
  class Derived extends Base {}

  const derived = new Derived();
  const result = await resolveEdge(derived, "child", [], {});
  expect(result).toBeInstanceOf(Child);
});

test("resolveGet works on inherited method", async () => {
  class Base {
    @method
    async greet(): Promise<string> {
      return "hello";
    }
  }
  class Derived extends Base {}

  const derived = new Derived();
  const result = await resolveGet(derived, "greet", [], {});
  expect(result).toBe("hello");
});

// -- Security hardening tests --

test("resolveGet blocks __proto__ access", async () => {
  class TestNode {
    name = "test";
  }
  const node = new TestNode();
  expect(resolveGet(node, "__proto__", [], {})).rejects.toBeInstanceOf(
    MethodNotFoundError,
  );
});

test("resolveGet blocks prototype access", async () => {
  class TestNode {
    name = "test";
  }
  const node = new TestNode();
  expect(resolveGet(node, "prototype", [], {})).rejects.toBeInstanceOf(
    MethodNotFoundError,
  );
});

test("resolveGet blocks @edge member access (must use edge op)", async () => {
  class Child extends Node {}
  class Parent {
    @edge(Child)
    get child(): Child {
      return new Child();
    }
  }
  const parent = new Parent();
  expect(resolveGet(parent, "child", [], {})).rejects.toBeInstanceOf(
    MethodNotFoundError,
  );
});

test("resolveGet rejects args on non-@method", async () => {
  class TestNode {
    name = "test";
  }
  const node = new TestNode();
  expect(
    resolveGet(node, "name", ["unexpected-arg"], {}),
  ).rejects.toBeInstanceOf(MethodNotFoundError);
});

test("resolveGet accesses getter on user class", async () => {
  class TestNode {
    get computed(): number {
      return 42;
    }
  }
  const node = new TestNode();
  const result = await resolveGet(node, "computed", [], {});
  expect(result).toBe(42);
});

test("resolveGet rejects getter returning function", async () => {
  class TestNode {
    get action(): () => void {
      return () => {};
    }
  }
  const node = new TestNode();
  expect(resolveGet(node, "action", [], {})).rejects.toBeInstanceOf(
    MethodNotFoundError,
  );
});

test("resolveGet accesses inherited own property", async () => {
  class Base {
    baseProp = "base-value";
  }
  class Derived extends Base {
    name = "derived";
  }
  const derived = new Derived();
  // baseProp is set on the instance by Base constructor, so it's an own property
  const result = await resolveGet(derived, "baseProp", [], {});
  expect(result).toBe("base-value");
});

test("resolveGet calls inherited @method", async () => {
  class Base {
    @method
    async baseMethod(): Promise<string> {
      return "from-base";
    }
  }
  class Derived extends Base {}
  const derived = new Derived();
  const result = await resolveGet(derived, "baseMethod", [], {});
  expect(result).toBe("from-base");
});

test("resolveGet returns non-getter prototype value property", async () => {
  class Base {}
  Object.defineProperty(Base.prototype, "protoValue", {
    value: 42,
    writable: true,
    configurable: true,
  });
  const node = new Base();
  const result = await resolveGet(node, "protoValue", [], {});
  expect(result).toBe(42);
});

test("resolveGet rejects non-getter prototype function value", async () => {
  class Base {}
  Object.defineProperty(Base.prototype, "protoFn", {
    value: () => {},
    writable: true,
    configurable: true,
  });
  const node = new Base();
  expect(resolveGet(node, "protoFn", [], {})).rejects.toBeInstanceOf(
    MethodNotFoundError,
  );
});

test("resolveData includes non-getter prototype value property", () => {
  class Base {
    name = "test";
  }
  Object.defineProperty(Base.prototype, "protoValue", {
    value: 42,
    writable: true,
    configurable: true,
  });
  const node = new Base();
  const data = resolveData(node, {});
  expect(data).toEqual({ name: "test", protoValue: 42 });
});

test("resolveData excludes non-getter prototype function value", () => {
  class Base {
    name = "test";
  }
  Object.defineProperty(Base.prototype, "protoFn", {
    value: () => {},
    writable: true,
    configurable: true,
  });
  const node = new Base();
  const data = resolveData(node, {});
  expect(data).toEqual({ name: "test" });
  expect(data).not.toHaveProperty("protoFn");
});
