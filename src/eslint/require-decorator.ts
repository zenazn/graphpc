/**
 * ESLint rule: graphpc/require-decorator
 *
 * Ensures every public method on a Node subclass is decorated with @edge, @method, @stream, or @hidden.
 * Undecorated public methods are invisible to the RPC framework — the runtime rejects them,
 * but they still appear in autocomplete, which is confusing.
 *
 * Known limitation: only detects direct `extends Node`, not transitive inheritance.
 */

import type { TSESTree } from "@typescript-eslint/utils";
import { ESLintUtils } from "@typescript-eslint/utils";

const GRAPHPC_DECORATOR_NAMES = new Set(["edge", "method", "stream", "hidden"]);

const createRule = ESLintUtils.RuleCreator(
  () =>
    "https://github.com/zenazn/graphpc/blob/main/docs/types.md#eslint-plugin",
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
 * Find the local name of a namespace import of "graphpc"
 * (`import * as graphpc from "graphpc"`).
 */
function findNamespaceImport(program: TSESTree.Program): string | null {
  for (const stmt of program.body) {
    if (stmt.type !== "ImportDeclaration" || stmt.source.value !== "graphpc") {
      continue;
    }
    for (const spec of stmt.specifiers) {
      if (spec.type === "ImportNamespaceSpecifier") return spec.local.name;
    }
  }
  return null;
}

/**
 * True if a class's superClass refers to graphpc's Node — either the named
 * import local (`extends Node`) or a namespace member (`extends graphpc.Node`).
 */
function extendsNode(
  superClass: TSESTree.ClassDeclaration["superClass"],
  nodeImportLocal: string | null,
  namespaceLocal: string | null,
): boolean {
  if (!superClass) return false;
  if (superClass.type === "Identifier") {
    return nodeImportLocal !== null && superClass.name === nodeImportLocal;
  }
  if (
    superClass.type === "MemberExpression" &&
    namespaceLocal !== null &&
    superClass.object.type === "Identifier" &&
    superClass.object.name === namespaceLocal &&
    superClass.property.type === "Identifier" &&
    superClass.property.name === "Node"
  ) {
    return true;
  }
  return false;
}

/**
 * Collect the local names of graphpc decorator imports.
 * E.g. `import { method as m } from "graphpc"` → returns Set(["m"]).
 */
function collectDecoratorLocals(program: TSESTree.Program): Set<string> {
  const locals = new Set<string>();
  for (const stmt of program.body) {
    if (stmt.type !== "ImportDeclaration" || stmt.source.value !== "graphpc") {
      continue;
    }
    for (const spec of stmt.specifiers) {
      if (spec.type !== "ImportSpecifier") continue;
      const importedName =
        spec.imported.type === "Identifier"
          ? spec.imported.name
          : String(spec.imported.value);
      if (GRAPHPC_DECORATOR_NAMES.has(importedName)) {
        locals.add(spec.local.name);
      }
    }
  }
  return locals;
}

/**
 * Check if a method definition has a graphpc decorator (@edge, @method, @stream, or @hidden).
 */
function hasGraphpcDecorator(
  node: TSESTree.MethodDefinition,
  decoratorLocals: Set<string>,
  namespaceLocal: string | null,
): boolean {
  if (!node.decorators || node.decorators.length === 0) return false;
  // `graphpc.method` / `graphpc.method(...)` when imported as a namespace.
  const isNamespaceMember = (e: TSESTree.Node): boolean =>
    e.type === "MemberExpression" &&
    namespaceLocal !== null &&
    e.object.type === "Identifier" &&
    e.object.name === namespaceLocal &&
    e.property.type === "Identifier" &&
    GRAPHPC_DECORATOR_NAMES.has(e.property.name);
  return node.decorators.some((d) => {
    const expr = d.expression;
    // @method, @edge, @hidden (bare identifier)
    if (expr.type === "Identifier") {
      return decoratorLocals.has(expr.name);
    }
    // @graphpc.method
    if (isNamespaceMember(expr)) return true;
    // @method(...) / @graphpc.method(...)
    if (expr.type === "CallExpression") {
      if (expr.callee.type === "Identifier") {
        return decoratorLocals.has(expr.callee.name);
      }
      return isNamespaceMember(expr.callee);
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
        "Require @edge, @method, @stream, or @hidden on public methods of Node subclasses",
    },
    messages: {
      missingDecorator:
        'Public method "{{name}}" on Node subclass "{{className}}" must be decorated with @edge, @method, @stream, or @hidden. Undecorated methods are rejected at runtime.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    let nodeImportLocal: string | null = null;
    let namespaceLocal: string | null = null;
    let decoratorLocals = new Set<string>();

    function checkClass(
      node: TSESTree.ClassDeclaration | TSESTree.ClassExpression,
    ) {
      if (!nodeImportLocal && !namespaceLocal) return;
      if (!extendsNode(node.superClass, nodeImportLocal, namespaceLocal))
        return;

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

        // Skip symbol-keyed / dynamically-computed methods (e.g.
        // [Symbol.asyncIterator]() or [expr]()). A well-known-symbol protocol
        // method can't carry an @edge/@method/@stream/@hidden decorator, so
        // flagging it would be an unfixable false positive. A computed *string
        // literal* key (["doStuff"]()) is still addressable and stays flagged.
        if (member.computed && member.key.type !== "Literal") {
          continue;
        }

        // Skip TS overload signatures / bodiless declarations — a decorator is
        // only legal on the implementation, so flagging the signatures would be
        // an unfixable false positive.
        if (member.value.type === "TSEmptyBodyFunctionExpression") {
          continue;
        }

        // Skip if already decorated
        if (hasGraphpcDecorator(member, decoratorLocals, namespaceLocal))
          continue;

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
    }

    return {
      Program(program) {
        const spec = findNodeImport(program);
        if (spec) {
          nodeImportLocal = spec.local.name;
        }
        namespaceLocal = findNamespaceImport(program);
        decoratorLocals = collectDecoratorLocals(program);
      },

      ClassDeclaration: checkClass,
      ClassExpression: checkClass,
    };
  },
});
