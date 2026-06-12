/**
 * Add explicit `.js` extensions to relative import specifiers in the emitted
 * declaration files.
 *
 * Source files use extensionless relative imports (which Bun and bundler
 * resolution handle), but consumers on `moduleResolution: node16`/`nodenext`
 * require explicit extensions inside `.d.ts` files — without them, every
 * import from "graphpc" silently degrades to `any` under `skipLibCheck`.
 * tsc has no emit option for this, so we rewrite the output.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function* dtsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* dtsFiles(path);
    else if (entry.name.endsWith(".d.ts")) yield path;
  }
}

// Matches `from "./x"`, `export ... from "../x"`, and `import("./x")` type
// references. Specifiers that already carry an extension are left alone.
const specifier = /(\bfrom\s*|\bimport\s*\(\s*)("\.\.?\/[^"]+")/g;

let rewritten = 0;
for (const file of dtsFiles("dist")) {
  const source = readFileSync(file, "utf8");
  const output = source.replace(specifier, (match, prefix, quoted) => {
    const path = quoted.slice(1, -1);
    if (/\.[cm]?[jt]s$/.test(path) || path.endsWith(".json")) return match;
    return `${prefix}"${path}.js"`;
  });
  if (output !== source) {
    writeFileSync(file, output);
    rewritten++;
  }
}
console.log(`fix-dts-extensions: rewrote ${rewritten} declaration file(s)`);
