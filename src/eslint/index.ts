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

const plugin = {
  meta: {
    name: "graphpc",
    // Keep in lockstep with package.json — enforced by index.test.ts so it
    // can't silently drift. (Not imported from package.json: that would pull
    // a repo-root file into the .d.ts build graph and break the dist layout.)
    version: "0.9.4",
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
