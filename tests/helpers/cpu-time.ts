/**
 * @fileoverview CPU-time measurement for the suite's linear-time regression tests.
 * Wall-clock time also counts every moment the test's thread waits for a core, so on a
 * loaded machine it measures the scheduler as much as the code. These helpers read the
 * main thread's own CPU time (`process.threadCpuUsage`, Node ≥23.9 and Bun), which stops
 * while the thread is descheduled and leaves out other threads, so it tracks the work the
 * code under test does, whatever else the machine runs.
 * @module tests/helpers/cpu-time
 */

import { expect } from 'vitest';

/**
 * Wall-clock timeout for a test these helpers time. Its assertions are on CPU time, so the
 * wall clock gets room enough on a loaded machine never to decide the result.
 */
export const CPU_TIMED_TEST_TIMEOUT_MS = 120_000;

/**
 * CPU time one sample runs before it is divided into a per-call figure. A single call of a
 * few hundred microseconds is near the clock's resolution and swings with one cache miss;
 * 20 ms of repeated calls averages that out.
 */
const SAMPLE_CPU_MS = 20;

/** Rounds per size; the fastest is kept, leaving out a collection or a cold cache that landed on one. */
const ROUNDS = 5;

/** Main-thread CPU time since `start`, in milliseconds. */
function cpuMsSince(start: NodeJS.CpuUsage): number {
  const { user, system } = process.threadCpuUsage(start);
  return (user + system) / 1000;
}

/** Main-thread CPU time per call of `run`, in milliseconds, over calls totalling about 20 ms. */
export async function cpuMsPerCall(run: () => unknown): Promise<number> {
  const start = process.threadCpuUsage();
  let calls = 0;
  let used = 0;
  do {
    await run();
    calls++;
    used = cpuMsSince(start);
  } while (used < SAMPLE_CPU_MS);
  return used / calls;
}

/** Input sizes, 64× apart: linear work grows ×64 across them, quadratic ×4,096. */
const SMALL = 2_500;
const LARGE = 160_000;

/**
 * Asserts that the work `setup(n)` returns grows linearly with `n`. `setup` builds the
 * input for an `n`-character case outside the measurement and returns the call to time.
 *
 * Each size's time is the fastest of five samples, the rounds alternating between the
 * sizes so a stretch on a slower core slows both alike. The 160k time over the 2.5k time
 * is at most 64 for a linear pass and about 4,096 for a quadratic one; it must stay under
 * 256, which leaves linear work four times its own headroom and stays sixteen times under
 * quadratic. A quadratic term still small next to a heavy linear one can hold that ratio
 * down while multiplying the time, so the 160k call must also stay under `maxLargeMs`,
 * checked after every sample so a quadratic fails on its first large call instead of
 * running all five.
 */
export async function expectLinearScaling(
  setup: (n: number) => () => unknown,
  maxLargeMs: number,
): Promise<void> {
  const small = setup(SMALL);
  const large = setup(LARGE);
  let tSmall = Number.POSITIVE_INFINITY;
  let tLarge = Number.POSITIVE_INFINITY;
  const timings = () =>
    `${tLarge.toFixed(3)} ms CPU at ${LARGE} characters, ${tSmall.toFixed(3)} ms at ${SMALL}`;
  for (let round = 0; round < ROUNDS; round++) {
    tSmall = Math.min(tSmall, await cpuMsPerCall(small));
    tLarge = Math.min(tLarge, await cpuMsPerCall(large));
    expect(tLarge, timings()).toBeLessThan(maxLargeMs);
  }
  expect(tLarge / tSmall, timings()).toBeLessThan(256);
}
