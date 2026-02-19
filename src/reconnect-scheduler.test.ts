import { test, expect } from "bun:test";
import { ReconnectScheduler } from "./reconnect-scheduler.ts";
import { fakeTimers } from "./test-utils.ts";

const defaultConfig = {
  maxRetries: 5,
  initialDelay: 1000,
  maxDelay: 30000,
  multiplier: 2,
};

test("first attempt has delay=0", () => {
  const ft = fakeTimers();
  const scheduler = new ReconnectScheduler(defaultConfig, ft);

  const calls: string[] = [];
  const result = scheduler.schedule(() => calls.push("attempt"));

  expect(result).toBe(true);
  expect(ft.getDelay()).toBe(0);

  ft.fire();
  expect(calls).toEqual(["attempt"]);
});

test("subsequent attempts use exponential backoff", () => {
  const ft = fakeTimers();
  const scheduler = new ReconnectScheduler(
    { maxRetries: 5, initialDelay: 100, maxDelay: 10000, multiplier: 2 },
    ft,
  );

  const delays: number[] = [];

  // First attempt: delay=0 (immediate)
  scheduler.schedule(() => {});
  delays.push(ft.getDelay()!);
  ft.fire(); // attempt 0→1, delay stays 100 (initialDelay)

  // Second attempt: delay=100 (initialDelay)
  scheduler.schedule(() => {});
  delays.push(ft.getDelay()!);
  ft.fire(); // attempt 1→2, delay bumps to 100*2=200

  // Third attempt: delay=200
  scheduler.schedule(() => {});
  delays.push(ft.getDelay()!);
  ft.fire(); // attempt 2→3, delay bumps to 200*2=400

  // Fourth attempt: delay=400
  scheduler.schedule(() => {});
  delays.push(ft.getDelay()!);
  ft.fire();

  expect(delays).toEqual([0, 100, 200, 400]);
});

test("maxDelay caps computed delay", () => {
  const ft = fakeTimers();
  const scheduler = new ReconnectScheduler(
    { maxRetries: 10, initialDelay: 1000, maxDelay: 2000, multiplier: 10 },
    ft,
  );

  const delays: number[] = [];

  // First: 0 (immediate), fires → delay stays 1000 (initialDelay)
  scheduler.schedule(() => {});
  delays.push(ft.getDelay()!);
  ft.fire();

  // Second: 1000 (initialDelay), fires → delay bumps to min(1000*10, 2000)=2000
  scheduler.schedule(() => {});
  delays.push(ft.getDelay()!);
  ft.fire();

  // Third: 2000 (capped), fires → delay stays 2000
  scheduler.schedule(() => {});
  delays.push(ft.getDelay()!);
  ft.fire();

  // Fourth: 2000 (capped)
  scheduler.schedule(() => {});
  delays.push(ft.getDelay()!);
  ft.fire();

  expect(delays).toEqual([0, 1000, 2000, 2000]);
});

test("returns false when maxRetries exhausted", () => {
  const ft = fakeTimers();
  const scheduler = new ReconnectScheduler(
    { maxRetries: 2, initialDelay: 10, maxDelay: 1000, multiplier: 2 },
    ft,
  );

  // Attempt 1 (attempt=0 → ok)
  expect(scheduler.schedule(() => {})).toBe(true);
  ft.fire();

  // Attempt 2 (attempt=1 → ok)
  expect(scheduler.schedule(() => {})).toBe(true);
  ft.fire();

  // Attempt 3 (attempt=2 >= maxRetries=2 → exhausted)
  expect(scheduler.schedule(() => {})).toBe(false);
});

test("reset() restores initial state", () => {
  const ft = fakeTimers();
  const scheduler = new ReconnectScheduler(
    { maxRetries: 2, initialDelay: 100, maxDelay: 1000, multiplier: 2 },
    ft,
  );

  // Use up attempts
  scheduler.schedule(() => {});
  ft.fire();
  scheduler.schedule(() => {});
  ft.fire();

  // Exhausted
  expect(scheduler.schedule(() => {})).toBe(false);

  // Reset
  scheduler.reset();

  // Can schedule again, first attempt has delay=0
  expect(scheduler.schedule(() => {})).toBe(true);
  expect(ft.getDelay()).toBe(0);
});

test("cancel() clears pending timer", () => {
  const ft = fakeTimers();
  const scheduler = new ReconnectScheduler(defaultConfig, ft);

  scheduler.schedule(() => {});
  expect(ft.pending()).toBe(1);

  scheduler.cancel();
  expect(ft.pending()).toBe(0);
});

test("schedule after cancel still works", () => {
  const ft = fakeTimers();
  const scheduler = new ReconnectScheduler(defaultConfig, ft);

  // Schedule and cancel
  scheduler.schedule(() => {});
  scheduler.cancel();
  expect(ft.pending()).toBe(0);

  // Schedule again — still works
  const calls: string[] = [];
  const result = scheduler.schedule(() => calls.push("retry"));
  expect(result).toBe(true);

  ft.fire();
  expect(calls).toEqual(["retry"]);
});

test("re-entrant schedule from onAttempt works correctly", () => {
  const ft = fakeTimers();
  const scheduler = new ReconnectScheduler(
    { maxRetries: 3, initialDelay: 100, maxDelay: 10000, multiplier: 2 },
    ft,
  );

  const delays: number[] = [];

  // Simulate: onAttempt throws, caller re-schedules
  scheduler.schedule(() => {
    // Callback fires — simulating a factory throw, caller calls schedule again
    delays.push(ft.getDelay() ?? -1);
    scheduler.schedule(() => {
      delays.push(ft.getDelay() ?? -1);
    });
  });

  // First timer: delay=0
  expect(ft.getDelay()).toBe(0);
  ft.fire();
  // After first fire, attempt is now 1, delay stays at 100 (initialDelay)
  // The re-entrant schedule should use delay=100
  expect(ft.pending()).toBe(1);
  expect(ft.getDelay()).toBe(100);
});
