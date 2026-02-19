/**
 * ReconnectScheduler — extracted from client.ts.
 *
 * Manages exponential backoff reconnection timing.
 * First attempt is immediate (delay=0), subsequent attempts use
 * exponential backoff capped at maxDelay.
 */

import { type Timers, defaultTimers } from "./types.ts";

interface ReconnectConfig {
  maxRetries: number;
  initialDelay: number;
  maxDelay: number;
  multiplier: number;
}

export class ReconnectScheduler {
  private attempt = 0;
  private delay: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly config: ReconnectConfig;
  private readonly timers: Timers;

  constructor(config: ReconnectConfig, timers?: Partial<Timers>) {
    this.config = config;
    this.delay = config.initialDelay;
    const defaults = defaultTimers();
    this.timers = {
      setTimeout: timers?.setTimeout ?? defaults.setTimeout,
      clearTimeout: timers?.clearTimeout ?? defaults.clearTimeout,
    };
  }

  /**
   * Schedule a reconnection attempt.
   * @param onAttempt - Called when the timer fires (or immediately for first attempt).
   * @returns false if maxRetries exhausted, true otherwise.
   */
  schedule(onAttempt: () => void): boolean {
    if (this.attempt >= this.config.maxRetries) {
      return false;
    }

    const currentDelay = this.attempt === 0 ? 0 : this.delay;

    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      // Increment attempt and update delay BEFORE calling onAttempt
      // (handles re-entrant schedule() if transport factory throws)
      this.attempt++;
      if (this.attempt > 1) {
        this.delay = Math.min(
          this.delay * this.config.multiplier,
          this.config.maxDelay,
        );
      }
      onAttempt();
    }, currentDelay);

    return true;
  }

  /** Reset after successful reconnection. */
  reset(): void {
    this.attempt = 0;
    this.delay = this.config.initialDelay;
    this.cancel();
  }

  /** Cancel any pending reconnect timer. */
  cancel(): void {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
