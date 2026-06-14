import { expect, test } from "bun:test";
import { createCacheEntry, getNode } from "./context";

type Deferred = {
  promise: Promise<object>;
  resolve: (v: object) => void;
  reject: (e: unknown) => void;
};
function deferred(): Deferred {
  let resolve!: (v: object) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<object>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("a stale resolution does not corrupt a freshly re-resolved cache entry", async () => {
  const gates = [deferred(), deferred()];
  let call = 0;
  const entry = createCacheEntry(() => gates[call++]!.promise);

  // First resolution kicks off (in-flight).
  const p1 = entry.resolve === undefined ? null : getNode(entry);
  void p1;

  // ref() force-invalidates an in-flight entry: null the promise + bump version.
  entry.promise = null;
  entry.settled = false;
  entry.rejected = false;
  entry.version++;

  // Fresh resolution; make it succeed.
  const p2 = getNode(entry);
  gates[1]!.resolve({ fresh: true });
  await p2;
  expect(entry.settled).toBe(true);
  expect(entry.rejected).toBe(false);

  // The stale (old) promise now rejects — it must NOT flip the fresh entry.
  gates[0]!.reject(new Error("stale"));
  await Promise.resolve();
  await Promise.resolve();

  expect(entry.rejected).toBe(false);
  expect(entry.settled).toBe(true);
});
