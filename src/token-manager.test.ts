import { test, expect } from "bun:test";
import { TokenManager } from "./token-manager.ts";
import { PoisonedTokenError, RpcError } from "./errors.ts";

const root = { name: "root" };

test("claim() assigns sequential tokens starting at 1", () => {
  const tm = new TokenManager(root);
  expect(tm.claim().token).toBe(1);
  expect(tm.claim().token).toBe(2);
  expect(tm.claim().token).toBe(3);
});

test("get() returns root for token 0", () => {
  const tm = new TokenManager(root);
  expect(tm.get(0)).toBe(root);
});

test("register() makes node retrievable via get()", () => {
  const tm = new TokenManager(root);
  const child = { name: "child" };
  const claim = tm.claim();
  claim.register(child);
  expect(tm.get(claim.token)).toBe(child);
});

test("get() throws RpcError for unknown token", () => {
  const tm = new TokenManager(root);
  expect(() => tm.get(99)).toThrow(RpcError);
  try {
    tm.get(99);
  } catch (err) {
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe("INVALID_TOKEN");
  }
});

test("get() throws PoisonedTokenError for poisoned token", () => {
  const tm = new TokenManager(root);
  const claim = tm.claim();
  const cause = new RpcError("EDGE_ERROR", "boom");
  claim.poison(cause);
  try {
    tm.get(claim.token);
    expect.unreachable("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(PoisonedTokenError);
    expect((err as PoisonedTokenError).originalError).toBe(cause);
    expect((err as PoisonedTokenError).token).toBe(claim.token);
  }
});

test("poison() unwraps PoisonedTokenError to store root cause", () => {
  const tm = new TokenManager(root);
  const claim1 = tm.claim();
  const rootCause = new RpcError("EDGE_ERROR", "original failure");
  claim1.poison(rootCause);

  // Simulate child traversal from poisoned parent
  const claim2 = tm.claim();
  try {
    tm.get(claim1.token);
  } catch (err) {
    // Parent access yields PoisonedTokenError wrapping rootCause
    claim2.poison(err as RpcError);
  }

  // Child's stored cause should be the root cause, not a wrapper
  try {
    tm.get(claim2.token);
    expect.unreachable("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(PoisonedTokenError);
    expect((err as PoisonedTokenError).originalError).toBe(rootCause);
  }
});

test("poison cascading: A→B→C chain stores root cause at each level", () => {
  const tm = new TokenManager(root);
  const rootCause = new RpcError("EDGE_ERROR", "root boom");

  const a = tm.claim();
  a.poison(rootCause);

  const b = tm.claim();
  try {
    tm.get(a.token);
  } catch (err) {
    b.poison(err as RpcError);
  }

  const c = tm.claim();
  try {
    tm.get(b.token);
  } catch (err) {
    c.poison(err as RpcError);
  }

  // All three should trace back to the same root cause
  for (const token of [a.token, b.token, c.token]) {
    try {
      tm.get(token);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as PoisonedTokenError).originalError).toBe(rootCause);
    }
  }
});

test("poison() is idempotent — second call is a no-op", () => {
  const tm = new TokenManager(root);
  const claim = tm.claim();
  const first = new RpcError("EDGE_ERROR", "first");
  const second = new RpcError("EDGE_ERROR", "second");
  claim.poison(first);
  claim.poison(second);

  try {
    tm.get(claim.token);
    expect.unreachable("should have thrown");
  } catch (err) {
    expect((err as PoisonedTokenError).originalError).toBe(first);
  }
});

test("token limit: claim beyond limit sets claim.error and shouldClose", () => {
  const tm = new TokenManager(root, 2); // root=token0 counts as 1
  const c1 = tm.claim();
  c1.register({ name: "a" }); // now 2 entries (root + a)
  expect(tm.shouldClose).toBe(false);

  const c2 = tm.claim();
  expect(c2.error).toBeInstanceOf(RpcError);
  expect(c2.error!.code).toBe("TOKEN_LIMIT_EXCEEDED");
  expect(tm.shouldClose).toBe(true);
});

test("token limit: pre-poisoned claim token is retrievable as poisoned", () => {
  const tm = new TokenManager(root, 1); // only root fits
  const claim = tm.claim();
  expect(claim.error).toBeDefined();

  try {
    tm.get(claim.token);
    expect.unreachable("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(PoisonedTokenError);
    expect((err as PoisonedTokenError).originalError).toBeInstanceOf(RpcError);
    expect(((err as PoisonedTokenError).originalError as RpcError).code).toBe(
      "TOKEN_LIMIT_EXCEEDED",
    );
  }
});

test("clear() releases all state", () => {
  const tm = new TokenManager(root);
  const claim = tm.claim();
  claim.register({ name: "child" });

  tm.clear();

  expect(() => tm.get(0)).toThrow(RpcError);
  expect(() => tm.get(claim.token)).toThrow(RpcError);
});
