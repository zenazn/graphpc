import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, expect, test } from "bun:test";
import { requireDecorator } from "./require-decorator.ts";

// Wire RuleTester to bun:test
RuleTester.afterAll = () => {};
RuleTester.describe = describe;
RuleTester.it = test;
// RuleTester.itOnly = test.only;

const tester = new RuleTester();

tester.run("require-decorator", requireDecorator, {
  valid: [
    // All methods decorated
    {
      code: `
        import { Node, edge, method, hidden } from "graphpc";

        class Api extends Node {
          @edge(PostsService)
          get posts() { return new PostsService(); }

          @method
          async ping() { return "pong"; }
        }
      `,
    },
    // Private methods are ignored
    {
      code: `
        import { Node } from "graphpc";

        class Api extends Node {
          private doStuff() { return 1; }
        }
      `,
    },
    // Protected methods are ignored
    {
      code: `
        import { Node } from "graphpc";

        class Api extends Node {
          protected doStuff() { return 1; }
        }
      `,
    },
    // ES private names are ignored
    {
      code: `
        import { Node } from "graphpc";

        class Api extends Node {
          #doStuff() { return 1; }
        }
      `,
    },
    // Static methods are ignored
    {
      code: `
        import { Node } from "graphpc";

        class Api extends Node {
          static helper() { return 1; }
        }
      `,
    },
    // Class not extending Node — no check
    {
      code: `
        import { Node } from "graphpc";

        class Foo {
          doStuff() { return 1; }
        }
      `,
    },
    // No Node import — no check
    {
      code: `
        class Api extends Node {
          doStuff() { return 1; }
        }
      `,
    },
    // Getters are not flagged (they're data fields)
    {
      code: `
        import { Node } from "graphpc";

        class Api extends Node {
          get version() { return "1.0"; }
        }
      `,
    },
    // @hidden counts as decorated
    {
      code: `
        import { Node, hidden, method } from "graphpc";

        class Api extends Node {
          @hidden((ctx) => !ctx.isAdmin)
          @method
          async secretData() { return "secret"; }
        }
      `,
    },
  ],

  invalid: [
    // Undecorated public method
    {
      code: `
        import { Node } from "graphpc";

        class Api extends Node {
          doStuff() { return 1; }
        }
      `,
      errors: [
        {
          messageId: "missingDecorator",
          data: { name: "doStuff", className: "Api" },
        },
      ],
    },
    // Multiple undecorated methods
    {
      code: `
        import { Node, edge } from "graphpc";

        class Api extends Node {
          @edge(PostsService)
          get posts() { return new PostsService(); }

          doStuff() { return 1; }
          doMore() { return 2; }
        }
      `,
      errors: [
        {
          messageId: "missingDecorator",
          data: { name: "doStuff", className: "Api" },
        },
        {
          messageId: "missingDecorator",
          data: { name: "doMore", className: "Api" },
        },
      ],
    },
    // Renamed import — rule tracks local name
    {
      code: `
        import { Node as BaseNode } from "graphpc";

        class Api extends BaseNode {
          doStuff() { return 1; }
        }
      `,
      errors: [
        {
          messageId: "missingDecorator",
          data: { name: "doStuff", className: "Api" },
        },
      ],
    },
    // Async undecorated method
    {
      code: `
        import { Node } from "graphpc";

        class PostsService extends Node {
          async list() { return []; }
        }
      `,
      errors: [
        {
          messageId: "missingDecorator",
          data: { name: "list", className: "PostsService" },
        },
      ],
    },
  ],
});
