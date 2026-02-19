/**
 * Benchmark: formatPath / formatValue vs devalue.stringify
 *
 * Run: bun src/format.bench.ts
 */

import { stringify } from "devalue";
import { formatPath, formatValue } from "./format.ts";
import type { PathSegments } from "./path.ts";

function bench(name: string, fn: () => void, iterations = 100_000) {
  // Warmup
  for (let i = 0; i < 1_000; i++) fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - start;
  const opsPerSec = Math.round((iterations / elapsed) * 1_000);
  console.log(
    `  ${name}: ${opsPerSec.toLocaleString()} ops/sec (${((elapsed / iterations) * 1_000).toFixed(2)} µs/op)`,
  );
}

// -- Test data --

const simplePath: PathSegments = ["posts", ["get", "42"]];

const complexPath: PathSegments = [
  "users",
  ["get", "abc-123"],
  "posts",
  ["query", "recent", 10, true],
  "comments",
];

const largeObject = {
  users: Array.from({ length: 20 }, (_, i) => ({
    id: i,
    name: `User ${i}`,
    email: `user${i}@example.com`,
    active: i % 2 === 0,
    tags: ["tag1", "tag2"],
    metadata: { created: new Date("2024-01-01"), score: i * 1.5 },
  })),
};

// -- Benchmarks --

console.log("Simple path:");
bench("formatPath", () => formatPath(simplePath));
bench("devalue.stringify", () => stringify(simplePath));

console.log("\nComplex path:");
bench("formatPath", () => formatPath(complexPath));
bench("devalue.stringify", () => stringify(complexPath));

console.log("\nLarge nested object:");
bench("formatValue", () => formatValue(largeObject), 10_000);
bench("devalue.stringify", () => stringify(largeObject), 10_000);
