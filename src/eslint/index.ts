/**
 * GraphPC ESLint plugin.
 *
 * Provides rules for catching common mistakes in GraphPC node class definitions.
 * Install @typescript-eslint/utils as a peer dependency to use this plugin.
 *
 * Usage (flat config):
 *
 *   import graphpc from "graphpc/eslint";
 *   export default [graphpc.configs.recommended];
 */

import { requireDecorator } from "./require-decorator.ts";

const plugin = {
  meta: {
    name: "graphpc",
    version: "0.1.0",
  },
  rules: {
    "require-decorator": requireDecorator,
  },
  configs: {} as Record<string, unknown>,
};

plugin.configs.recommended = {
  plugins: { graphpc: plugin },
  rules: {
    "graphpc/require-decorator": "error",
  },
};

export default plugin;
