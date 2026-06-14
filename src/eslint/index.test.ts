import { expect, test } from "bun:test";
import plugin from "./index";
import pkg from "../../package.json";

// The plugin version is hardcoded (importing package.json into the plugin
// source would pull a repo-root file into the .d.ts build graph and break the
// published dist layout). This test enforces that it stays in lockstep with
// package.json so ESLint cache invalidation / diagnostics never report a stale
// version.
test("plugin meta.version matches package.json", () => {
  expect(plugin.meta.version).toBe(pkg.version);
});

test("plugin exposes the require-decorator rule and recommended config", () => {
  expect(plugin.rules["require-decorator"]).toBeDefined();
  expect(plugin.configs.recommended).toBeDefined();
});
