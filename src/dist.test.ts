/**
 * Guards on the built package in dist/. These run whenever dist/ exists —
 * in particular during `prepublishOnly`, which builds before testing — and
 * skip silently in a fresh checkout.
 */

import { test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
