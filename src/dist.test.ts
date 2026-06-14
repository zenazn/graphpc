/**
 * Guards on the built package in dist/. These run whenever dist/ exists —
 * in particular during `prepublishOnly`, which builds before testing — and
 * skip silently in a fresh checkout.
 */

import { test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const distDir = join(import.meta.dir, "..", "dist");
const built = existsSync(join(distDir, "index.js"));

test.skipIf(!built)(
  "graphpc and graphpc/client share one class per error (instanceof works across entry points)",
  async () => {
    const indexPath = join(distDir, "index.js");
    const clientPath = join(distDir, "client-entry.js");
    const server = await import(indexPath);
    const client = await import(clientPath);
    // SSR processes import both entry points; an error created by one must
    // satisfy instanceof checks against the other.
    expect(server.RpcError).toBe(client.RpcError);
    expect(server.TokenExpiredError).toBe(client.TokenExpiredError);
    expect(new server.RpcError("X", "x")).toBeInstanceOf(client.RpcError);
  },
);

test.skipIf(!built)(
  "graphpc/client bundle has no Node.js (async_hooks) dependency",
  () => {
    // The graphpc/client entry must be bundleable for browsers/edge — it must
    // never transitively pull in node:async_hooks (from context.ts's
    // AsyncLocalStorage). This holds today only via a web of `import type`-only
    // edges; a value import would silently fold async_hooks into the chunk
    // under --target node with no build error. Walk the client entry's
    // transitive relative chunks and assert none references async_hooks.
    const importSpecifier = /(?:\bfrom\s*|\bimport\s*\(\s*)"(\.\.?\/[^"]+)"/g;
    const visited = new Set<string>();
    const offenders: string[] = [];
    const visit = (file: string) => {
      if (visited.has(file) || !existsSync(file)) return;
      visited.add(file);
      const source = readFileSync(file, "utf8");
      if (/async_hooks/.test(source)) offenders.push(file);
      for (const match of source.matchAll(importSpecifier)) {
        visit(join(dirname(file), match[1]!));
      }
    };
    visit(join(distDir, "client-entry.js"));
    expect(offenders).toEqual([]);
  },
);

test.skipIf(!built)(
  "declaration files use explicit extensions on relative imports (nodenext support)",
  () => {
    const offenders: string[] = [];
    const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*)"(\.\.?\/[^"]+)"/g;
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".d.ts")) {
          const source = readFileSync(path, "utf8");
          for (const match of source.matchAll(specifier)) {
            if (!/\.[cm]?[jt]s$/.test(match[1]!)) {
              offenders.push(`${path}: ${match[1]}`);
            }
          }
        }
      }
    };
    walk(distDir);
    expect(offenders).toEqual([]);
  },
);

test.skipIf(!built)(
  "declaration-file relative imports resolve to an emitted declaration",
  () => {
    // Stronger than the extension check: a rewritten specifier like "./foo.js"
    // must actually resolve to a "./foo.d.ts" (or "./foo/index.d.ts" for a
    // directory import) in dist. Catches the fix-dts directory-import footgun
    // where "./dir" is wrongly rewritten to "./dir.js" instead of
    // "./dir/index.js" — which the extension-only check would pass.
    const unresolved: string[] = [];
    const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*)"(\.\.?\/[^"]+)"/g;
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".d.ts")) {
          const source = readFileSync(path, "utf8");
          for (const match of source.matchAll(specifier)) {
            const spec = match[1]!;
            if (!/\.[cm]?js$/.test(spec)) continue; // only runtime-form specifiers
            const base = join(dirname(path), spec).replace(/\.[cm]?js$/, "");
            const candidates = [`${base}.d.ts`, join(base, "index.d.ts")];
            if (!candidates.some((c) => existsSync(c))) {
              unresolved.push(`${path}: ${spec}`);
            }
          }
        }
      }
    };
    walk(distDir);
    expect(unresolved).toEqual([]);
  },
);
