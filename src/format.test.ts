import { test, expect, describe } from "bun:test";
import { formatValue, formatPath, formatSegment } from "./format.ts";

// -- Primitives --

describe("formatValue primitives", () => {
  test("string", () => {
    expect(formatValue("hello")).toBe('"hello"');
    expect(formatValue("")).toBe('""');
    expect(formatValue('has "quotes"')).toBe('"has \\"quotes\\""');
  });

  test("number", () => {
    expect(formatValue(42)).toBe("42");
    expect(formatValue(3.14)).toBe("3.14");
    expect(formatValue(0)).toBe("0");
    expect(formatValue(-1)).toBe("-1");
  });

  test("NaN", () => {
    expect(formatValue(NaN)).toBe("NaN");
  });

  test("Infinity", () => {
    expect(formatValue(Infinity)).toBe("Infinity");
    expect(formatValue(-Infinity)).toBe("-Infinity");
  });

  test("-0", () => {
    expect(formatValue(-0)).toBe("-0");
  });

  test("boolean", () => {
    expect(formatValue(true)).toBe("true");
    expect(formatValue(false)).toBe("false");
  });

  test("null", () => {
    expect(formatValue(null)).toBe("null");
  });

  test("undefined", () => {
    expect(formatValue(undefined)).toBe("undefined");
  });

  test("bigint", () => {
    expect(formatValue(42n)).toBe("42n");
    expect(formatValue(0n)).toBe("0n");
    expect(formatValue(-1n)).toBe("-1n");
  });

  test("symbol", () => {
    expect(formatValue(Symbol("desc"))).toBe('Symbol("desc")');
    expect(formatValue(Symbol())).toBe("Symbol()");
  });
});

// -- Dates --

describe("formatValue Date", () => {
  test("valid date", () => {
    expect(formatValue(new Date("2024-01-01T00:00:00.000Z"))).toBe(
      'Date("2024-01-01T00:00:00.000Z")',
    );
  });

  test("invalid date", () => {
    expect(formatValue(new Date("invalid"))).toBe("Date(Invalid)");
  });
});

// -- RegExp --

describe("formatValue RegExp", () => {
  test("simple pattern", () => {
    expect(formatValue(/pattern/)).toBe("/pattern/");
  });

  test("with flags", () => {
    expect(formatValue(/pattern/gi)).toBe("/pattern/gi");
  });

  test("special chars in source", () => {
    expect(formatValue(/foo\.bar\d+/)).toBe("/foo\\.bar\\d+/");
  });
});

// -- URL / URLSearchParams --

describe("formatValue URL & URLSearchParams", () => {
  test("URL", () => {
    expect(formatValue(new URL("https://example.com/path?q=1"))).toBe(
      'URL("https://example.com/path?q=1")',
    );
  });

  test("URLSearchParams", () => {
    expect(formatValue(new URLSearchParams("a=1&b=2"))).toBe(
      'URLSearchParams("a=1&b=2")',
    );
  });
});

// -- Map --

describe("formatValue Map", () => {
  test("string keys and number values", () => {
    const m = new Map<string, number>([
      ["a", 1],
      ["b", 2],
    ]);
    expect(formatValue(m)).toBe('Map("a" => 1, "b" => 2)');
  });

  test("empty map", () => {
    expect(formatValue(new Map())).toBe("Map()");
  });

  test("mixed key types", () => {
    const m = new Map<unknown, unknown>([
      [1, "one"],
      [true, "yes"],
    ]);
    expect(formatValue(m)).toBe('Map(1 => "one", true => "yes")');
  });
});

// -- Set --

describe("formatValue Set", () => {
  test("various value types", () => {
    expect(formatValue(new Set([1, 2, 3]))).toBe("Set(1, 2, 3)");
  });

  test("empty set", () => {
    expect(formatValue(new Set())).toBe("Set()");
  });
});

// -- Arrays --

describe("formatValue Array", () => {
  test("normal array", () => {
    expect(formatValue([1, 2, 3])).toBe("[1, 2, 3]");
  });

  test("empty array", () => {
    expect(formatValue([])).toBe("[]");
  });

  test("nested array", () => {
    expect(formatValue([1, [2, 3]])).toBe("[1, [2, 3]]");
  });

  test("sparse array (holes)", () => {
    // eslint-disable-next-line no-sparse-arrays
    const arr = [1, , 3];
    expect(formatValue(arr)).toBe("[1, <hole>, 3]");
  });

  test("mixed types", () => {
    expect(formatValue([1, "two", true, null])).toBe('[1, "two", true, null]');
  });
});

// -- Objects --

describe("formatValue Object", () => {
  test("normal object", () => {
    expect(formatValue({ a: 1, b: 2 })).toBe("{a: 1, b: 2}");
  });

  test("empty object", () => {
    expect(formatValue({})).toBe("{}");
  });

  test("non-identifier keys", () => {
    expect(formatValue({ "weird-key": 1, normal: 2 })).toBe(
      '{"weird-key": 1, normal: 2}',
    );
  });

  test("null-prototype object", () => {
    const obj = Object.create(null);
    obj.a = 1;
    expect(formatValue(obj)).toBe("[Object: null prototype] {a: 1}");
  });

  test("nested object", () => {
    expect(formatValue({ a: { b: 1 } })).toBe("{a: {b: 1}}");
  });
});

// -- Boxed primitives --

describe("formatValue boxed primitives", () => {
  test("Number", () => {
    expect(formatValue(new Number(42))).toBe("Number(42)");
  });

  test("String", () => {
    expect(formatValue(new String("hi"))).toBe('String("hi")');
  });

  test("Boolean", () => {
    expect(formatValue(new Boolean(true))).toBe("Boolean(true)");
  });
});

// -- TypedArrays --

describe("formatValue TypedArray", () => {
  test("Uint8Array", () => {
    expect(formatValue(new Uint8Array([1, 2, 3]))).toBe(
      "Uint8Array([1, 2, 3])",
    );
  });

  test("Float64Array", () => {
    expect(formatValue(new Float64Array([1.5, 2.5]))).toBe(
      "Float64Array([1.5, 2.5])",
    );
  });

  test("BigInt64Array", () => {
    expect(formatValue(new BigInt64Array([1n, 2n]))).toBe(
      "BigInt64Array([1n, 2n])",
    );
  });
});

// -- ArrayBuffer --

describe("formatValue ArrayBuffer", () => {
  test("shows byte length", () => {
    expect(formatValue(new ArrayBuffer(16))).toBe("ArrayBuffer(16)");
  });
});

// -- Circular references --

describe("formatValue circular references", () => {
  test("self-referencing object", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(formatValue(obj)).toBe("{a: 1, self: $0}");
  });

  test("mutual references", () => {
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b" };
    a.other = b;
    b.other = a;
    expect(formatValue(a)).toBe('{name: "a", other: {name: "b", other: $0}}');
  });

  test("circular in array", () => {
    const arr: unknown[] = [1];
    arr.push(arr);
    expect(formatValue(arr)).toBe("[1, $0]");
  });

  test("circular in map", () => {
    const m = new Map<string, unknown>();
    m.set("self", m);
    expect(formatValue(m)).toBe('Map("self" => $0)');
  });
});

// -- Custom reducers --

describe("formatValue custom reducers", () => {
  class NotFound extends Error {
    constructor(
      public resource: string,
      public id: string,
    ) {
      super(`${resource} ${id} not found`);
    }
  }

  const reducers = {
    NotFound: (v: unknown) => v instanceof NotFound && [v.resource, v.id],
  };

  test("single custom type", () => {
    expect(formatValue(new NotFound("User", "123"), reducers)).toBe(
      'NotFound("User", "123")',
    );
  });

  test("custom type nested in object", () => {
    expect(formatValue({ error: new NotFound("Post", "42") }, reducers)).toBe(
      '{error: NotFound("Post", "42")}',
    );
  });

  test("zero-arg reducer", () => {
    class Sentinel {
      readonly _brand = true;
    }
    const r = {
      Sentinel: (v: unknown) => v instanceof Sentinel && [],
    };
    expect(formatValue(new Sentinel(), r)).toBe("Sentinel()");
  });

  test("multi-arg reducer", () => {
    class Point {
      constructor(
        public x: number,
        public y: number,
        public z: number,
      ) {}
    }
    const r = {
      Point: (v: unknown) => v instanceof Point && [v.x, v.y, v.z],
    };
    expect(formatValue(new Point(1, 2, 3), r)).toBe("Point(1, 2, 3)");
  });

  test("reducer returns false for non-matching value", () => {
    expect(formatValue("not an error", reducers)).toBe('"not an error"');
  });
});

// -- Path formatting --

describe("formatPath", () => {
  test("string segments", () => {
    expect(formatPath(["posts", "latest"])).toBe("root.posts.latest");
  });

  test("call segment with string arg", () => {
    expect(formatPath(["posts", ["get", "42"]])).toBe('root.posts.get("42")');
  });

  test("call segment with numeric arg", () => {
    expect(formatPath(["posts", ["get", 42]])).toBe("root.posts.get(42)");
  });

  test("mixed segments", () => {
    expect(formatPath(["users", ["get", "abc"], "posts", ["get", 1]])).toBe(
      'root.users.get("abc").posts.get(1)',
    );
  });

  test("non-identifier segment name", () => {
    expect(formatPath(["weird-name"])).toBe('root["weird-name"]');
  });

  test("non-identifier call segment name", () => {
    expect(formatPath([["weird-fn", 1]])).toBe('root["weird-fn"].weird-fn(1)');
  });

  test("empty path", () => {
    expect(formatPath([])).toBe("root");
  });

  test("call with multiple args", () => {
    expect(formatPath([["query", "users", 10, true]])).toBe(
      'root.query("users", 10, true)',
    );
  });

  test("call with no args", () => {
    expect(formatPath([["list"]])).toBe("root.list()");
  });

  test("various arg types in call", () => {
    expect(formatPath([["fetch", null, undefined, 42n]])).toBe(
      "root.fetch(null, undefined, 42n)",
    );
  });

  test("circular references tracked across segments", () => {
    const shared = { id: 1 };
    expect(
      formatPath([
        ["a", shared],
        ["b", shared],
      ]),
    ).toBe("root.a({id: 1}).b($0)");
  });
});

// -- Unambiguity --

describe("unambiguity", () => {
  const pairs: [string, unknown, unknown][] = [
    ["string '42' vs number 42", "42", 42],
    ["string 'null' vs null", "null", null],
    ["string 'true' vs boolean true", "true", true],
    ["string 'undefined' vs undefined", "undefined", undefined],
    ["string 'NaN' vs NaN", "NaN", NaN],
    ["string 'Infinity' vs Infinity", "Infinity", Infinity],
    ["number 0 vs -0", 0, -0],
    ["number 42 vs bigint 42n", 42, 42n],
    ["array [1] vs Set(1)", [1], new Set([1])],
    ["object vs Map", { a: 1 }, new Map([["a", 1]])],
  ];

  test.each(pairs)("%s", (_label, a, b) => {
    expect(formatValue(a)).not.toBe(formatValue(b));
  });
});

// -- formatSegment --

describe("formatSegment", () => {
  test("string segment (identifier)", () => {
    expect(formatSegment("posts")).toBe(".posts");
  });

  test("string segment (non-identifier)", () => {
    expect(formatSegment("weird-name")).toBe('["weird-name"]');
  });

  test("call segment with args", () => {
    expect(formatSegment(["get", "42"])).toBe('.get("42")');
  });

  test("call segment with no args", () => {
    expect(formatSegment(["list"])).toBe(".list()");
  });

  test("call segment with multiple args", () => {
    expect(formatSegment(["query", "users", 10])).toBe('.query("users", 10)');
  });

  test("incremental building matches formatPath", () => {
    const segments: import("./path.ts").PathSegments = [
      "users",
      ["get", "abc"],
      "posts",
    ];
    let key = "root";
    for (const seg of segments) {
      key += formatSegment(seg);
    }
    expect(key).toBe(formatPath(segments));
  });

  test("type-different args produce different keys", () => {
    expect(formatSegment(["get", "42"])).not.toBe(formatSegment(["get", 42]));
  });

  test("Date arg vs ISO string arg produce different keys", () => {
    const date = new Date("2024-01-01");
    expect(formatSegment(["get", date])).not.toBe(
      formatSegment(["get", date.toISOString()]),
    );
  });

  test("with custom reducers", () => {
    class Point {
      constructor(
        public x: number,
        public y: number,
      ) {}
    }
    const reducers = {
      Point: (v: unknown) => v instanceof Point && [v.x, v.y],
    };
    expect(formatSegment(["get", new Point(1, 2)], reducers)).toBe(
      ".get(Point(1, 2))",
    );
  });
});
