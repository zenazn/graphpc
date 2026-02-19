/**
 * Token lifecycle state machine.
 *
 * Owns the token→node and token→error maps, token allocation,
 * and limit enforcement. `waitFor` supports pipelining by letting
 * consumers block until a token is registered or poisoned.
 */

import { PoisonedTokenError, RpcError } from "./errors.ts";

export interface TokenClaim {
  /** The allocated token number. */
  readonly token: number;

  /**
   * Non-undefined if the token limit was exceeded.
   * The token is already poisoned in this case.
   */
  readonly error: RpcError | undefined;

  /** Store a resolved node for this token. */
  register(node: object): void;

  /**
   * Poison this token with an error.
   * Unwraps PoisonedTokenError to store root cause.
   * Idempotent — no-op if already poisoned.
   */
  poison(error: unknown): void;
}

export class TokenManager {
  readonly #tokens = new Map<number, object>();
  readonly #poisoned = new Map<number, unknown>();
  readonly #waiting = new Map<
    number,
    { resolve: (node: object) => void; reject: (err: RpcError) => void }[]
  >();
  readonly #maxTokens: number | undefined;
  #nextToken = 1; // 0 is root
  #shouldClose = false;

  constructor(root: object, maxTokens?: number) {
    this.#tokens.set(0, root);
    this.#maxTokens = maxTokens;
  }

  /**
   * Claim a new token. Returns a handle for the token's lifecycle.
   * If the limit is exceeded, the claim is pre-poisoned (claim.error is set).
   */
  claim(): TokenClaim {
    const token = this.#nextToken++;

    if (
      this.#maxTokens &&
      this.#tokens.size + this.#poisoned.size >= this.#maxTokens
    ) {
      this.#shouldClose = true;
      const error = new RpcError(
        "TOKEN_LIMIT_EXCEEDED",
        "Connection closed: token limit exceeded",
      );
      this.#poisoned.set(token, error);
      return this.#createClaim(token, error);
    }

    return this.#createClaim(token, undefined);
  }

  /**
   * Get the node for an existing token.
   * Throws PoisonedTokenError if poisoned, RpcError if unknown.
   */
  get(token: number): object {
    const cause = this.#poisoned.get(token);
    if (cause) throw new PoisonedTokenError(token, cause);
    const node = this.#tokens.get(token);
    if (!node) throw new RpcError("INVALID_TOKEN", `Unknown token: ${token}`);
    return node;
  }

  /**
   * Wait for a token to become available.
   * Returns immediately if the token is already registered.
   * Rejects with PoisonedTokenError if the token is (or becomes) poisoned.
   * Waits if the token hasn't been registered or poisoned yet (pipelining).
   */
  waitFor(token: number): Promise<object> {
    const node = this.#tokens.get(token);
    if (node) return Promise.resolve(node);

    const cause = this.#poisoned.get(token);
    if (cause) return Promise.reject(new PoisonedTokenError(token, cause));

    return new Promise((resolve, reject) => {
      let list = this.#waiting.get(token);
      if (!list) {
        list = [];
        this.#waiting.set(token, list);
      }
      list.push({ resolve, reject });
    });
  }

  /** Whether the connection should close (set when limit is hit). */
  get shouldClose(): boolean {
    return this.#shouldClose;
  }

  /** Release all state. */
  clear(): void {
    this.#tokens.clear();
    this.#poisoned.clear();
    const err = new RpcError("CONNECTION_CLOSED", "Connection closed");
    for (const waiters of this.#waiting.values()) {
      for (const w of waiters) w.reject(err);
    }
    this.#waiting.clear();
  }

  #createClaim(token: number, error: RpcError | undefined): TokenClaim {
    const tokens = this.#tokens;
    const poisoned = this.#poisoned;
    const waiting = this.#waiting;

    return {
      token,
      error,
      register(node: object) {
        if (poisoned.has(token)) return; // no-op if already poisoned (e.g. by timeout)
        tokens.set(token, node);
        const waiters = waiting.get(token);
        if (waiters) {
          waiting.delete(token);
          for (const w of waiters) w.resolve(node);
        }
      },
      poison(err: unknown) {
        if (poisoned.has(token)) return;
        const rootCause =
          err instanceof PoisonedTokenError ? err.originalError : err;
        poisoned.set(token, rootCause);
        const waiters = waiting.get(token);
        if (waiters) {
          waiting.delete(token);
          for (const w of waiters)
            w.reject(new PoisonedTokenError(token, rootCause));
        }
      },
    };
  }
}
