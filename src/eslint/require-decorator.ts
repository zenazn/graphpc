/**
 * ESLint rule: graphpc/require-decorator
 *
 * Ensures every public method on a Node subclass is decorated with @edge, @method, or @hidden.
 * Undecorated public methods are invisible to the RPC framework — the runtime rejects them,
 * but they still appear in autocomplete, which is confusing.
 *
 * Known limitation: only detects direct `extends Node`, not transitive inheritance.
 */

import type { TSESTree } from "@typescript-eslint/utils";
import { ESLintUtils } from "@typescript-eslint/utils";

const GRAPHPC_DECORATORS = new Set(["edge", "method", "hidden"]);

const createRule = ESLintUtils.RuleCreator(
  () =>
    "https://github.com/zenazn/graphpc/blob/main/docs/type-checking.md#eslint-plugin",
);

/**
 * Check whether an import specifier for "Node" comes from "graphpc".
 */
function findNodeImport(
  program: TSESTree.Program,
): TSESTree.ImportSpecifier | undefined {
  for (const stmt of program.body) {
    if (stmt.type !== "ImportDeclaration" || stmt.source.value !== "graphpc") {
      continue;
    }
    for (const spec of stmt.specifiers) {
      if (
        spec.type === "ImportSpecifier" &&
        ((spec.imported.type === "Identifier" &&
          spec.imported.name === "Node") ||
          (spec.imported.type === "Literal" && spec.imported.value === "Node"))
      ) {
        return spec;
      }
    }
  }
  return undefined;
}

/**
 * Get the name referenced by a class's superClass node.
 */
function getSuperClassName(node: TSESTree.ClassDeclaration): string | null {
  if (!node.superClass) return null;
  if (node.superClass.type === "Identifier") return node.superClass.name;
  return null;
}

/**
 * Check if a method definition has a graphpc decorator (@edge, @method, or @hidden).
 */
function hasGraphpcDecorator(node: TSESTree.MethodDefinition): boolean {
  if (!node.decorators || node.decorators.length === 0) return false;
  return node.decorators.some((d) => {
    const expr = d.expression;
    // @method, @edge, @hidden (bare identifier)
    if (expr.type === "Identifier") {
      return GRAPHPC_DECORATORS.has(expr.name);
    }
    // @method(...), @edge(...), @hidden(...)
    if (expr.type === "CallExpression" && expr.callee.type === "Identifier") {
      return GRAPHPC_DECORATORS.has(expr.callee.name);
    }
    return false;
  });
}

export const requireDecorator = createRule({
  name: "require-decorator",
  meta: {
    type: "problem",
    docs: {
      description:
        "Require @edge, @method, or @hidden on public methods of Node subclasses",
    },
    messages: {
      missingDecorator:
        'Public method "{{name}}" on Node subclass "{{className}}" must be decorated with @edge, @method, or @hidden. Undecorated methods are rejected at runtime.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    let nodeImportLocal: string | null = null;

    return {
      Program(program) {
        const spec = findNodeImport(program);
        if (spec) {
          nodeImportLocal = spec.local.name;
        }
      },

      ClassDeclaration(node) {
        if (!nodeImportLocal) return;

        const superName = getSuperClassName(node);
        if (superName !== nodeImportLocal) return;

        const className = node.id?.name ?? "(anonymous)";

        for (const member of node.body.body) {
          if (member.type !== "MethodDefinition") continue;

          // Skip constructors, getters, setters
          if (member.kind !== "method") continue;

          // Skip static methods
          if (member.static) continue;

          // Skip private/protected (TS accessibility)
          if (
            member.accessibility === "private" ||
            member.accessibility === "protected"
          ) {
            continue;
          }

          // Skip #private (ES private names)
          if (member.key.type === "PrivateIdentifier") {
            continue;
          }

          // Skip if already decorated
          if (hasGraphpcDecorator(member)) continue;

          const name =
            member.key.type === "Identifier"
              ? member.key.name
              : member.key.type === "Literal"
                ? String(member.key.value)
                : "(computed)";

          context.report({
            node: member,
            messageId: "missingDecorator",
            data: { name, className },
          });
        }
      },
    };
  },
});
