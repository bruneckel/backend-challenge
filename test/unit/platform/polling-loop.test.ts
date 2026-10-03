import { describe, expect, test } from 'bun:test';
import { PollingLoop } from '@platform/lifecycle/polling-loop';
import { ExponentialBackoff } from '@shared/domain/exponential-backoff';
import { waitUntil } from '@test/support/async';

const fastBackoff = ExponentialBackoff.create({
  baseMs: 5,
  maxMs: 20,
  random: () => 1,
});

describe('PollingLoop', () => {
  test('runs again right away while there is work and waits when idle', async () => {
    const results = [true, true, true, false];
    const calls: number[] = [];
    const loop = new PollingLoop({
      step: async () => {
        calls.push(Date.now());
        return results.shift() ?? false;
      },
      idleDelayMs: 200,
      errorBackoff: fastBackoff,
    });

    loop.start();
    await waitUntil(() => calls.length >= 4);
    await Bun.sleep(50);
    await loop.stop();

    expect(calls).toHaveLength(4);
    expect(calls[3]! - calls[0]!).toBeLessThan(150);
  });

  test('pauses between steps that found work when a busy delay is set', async () => {
    const results = [true, true, true, false];
    const calls: number[] = [];
    const loop = new PollingLoop({
      step: async () => {
        calls.push(performance.now());
        return results.shift() ?? false;
      },
      idleDelayMs: 1000,
      busyDelayMs: 60,
      errorBackoff: fastBackoff,
    });

    loop.start();
    await waitUntil(() => calls.length >= 4);
    await loop.stop();

    const gaps = calls.slice(1).map((at, index) => at - calls[index]!);
    expect(gaps.every((gap) => gap >= 55)).toBe(true);
  });

  test('backs off after failures, reports them and recovers after a success', async () => {
    const failures: number[] = [];
    let call = 0;
    const loop = new PollingLoop({
      step: async () => {
        call += 1;
        if (call <= 2) {
          throw new Error(`failure ${call}`);
        }
        return false;
      },
      idleDelayMs: 1000,
      errorBackoff: fastBackoff,
      onError: (_, consecutiveFailures) => failures.push(consecutiveFailures),
    });

    loop.start();
    await waitUntil(() => call >= 3);
    await loop.stop();

    expect(failures).toEqual([1, 2]);
  });

  test('finishes the step in progress before stopping and does not start another', async () => {
    let started = 0;
    let finished = 0;
    const loop = new PollingLoop({
      step: async () => {
        started += 1;
        await Bun.sleep(100);
        finished += 1;
        return true;
      },
      idleDelayMs: 10,
      errorBackoff: fastBackoff,
    });

    loop.start();
    await waitUntil(() => started === 1);
    await loop.stop();

    expect({ started, finished }).toEqual({ started: 1, finished: 1 });
  });

  test('stops promptly while waiting for the next poll', async () => {
    const loop = new PollingLoop({
      step: async () => false,
      idleDelayMs: 60_000,
      errorBackoff: fastBackoff,
    });
    loop.start();
    await Bun.sleep(20);

    const before = Date.now();
    await loop.stop();

    expect(Date.now() - before).toBeLessThan(100);
  });
});
