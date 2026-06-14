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

import { requireDecorator } from "./require-decorator";
import { version } from "../../package.json";

const plugin = {
  meta: {
    name: "graphpc",
    // Sourced from package.json so ESLint cache invalidation / diagnostics
    // report the actual installed version (the build inlines it).
    version,
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
