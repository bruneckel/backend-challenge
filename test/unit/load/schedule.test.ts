import { describe, expect, test } from 'bun:test';
import {
  arrivalOffsets,
  runClosedLoop,
  runOpenLoop,
} from '@test/load/schedule';

describe('arrivalOffsets', () => {
  test('spreads the arrivals of each phase evenly over its duration', () => {
    expect(
      arrivalOffsets([
        { durationSeconds: 1, ratePerSecond: 4 },
        { durationSeconds: 1, ratePerSecond: 2 },
      ]),
    ).toEqual([0, 250, 500, 750, 1000, 1500]);
  });

  test('skips a phase without traffic but keeps its time', () => {
    expect(
      arrivalOffsets([
        { durationSeconds: 1, ratePerSecond: 0 },
        { durationSeconds: 1, ratePerSecond: 1 },
      ]),
    ).toEqual([1000]);
  });
});

describe('runOpenLoop', () => {
  test('fires every arrival at its offset and drops those above the in-flight limit', async () => {
    const fired: number[] = [];
    const dropped: number[] = [];
    const release = Promise.withResolvers<void>();

    const run = runOpenLoop([0, 0, 0, 80], {
      maxInFlight: 2,
      fire: async (index) => {
        fired.push(index);
        if (index < 2) {
          await release.promise;
        }
      },
      onDropped: (index) => dropped.push(index),
    });
    await Bun.sleep(40);
    release.resolve();
    await run;

    expect(fired).toEqual([0, 1, 3]);
    expect(dropped).toEqual([2]);
  });
});

describe('runClosedLoop', () => {
  test('keeps the given number of workers busy until the deadline', async () => {
    const perWorker = new Map<number, number>();

    await runClosedLoop(3, 30, async (worker) => {
      perWorker.set(worker, (perWorker.get(worker) ?? 0) + 1);
      await Bun.sleep(5);
    });

    expect([...perWorker.keys()].sort()).toEqual([0, 1, 2]);
    expect([...perWorker.values()].every((count) => count >= 2)).toBe(true);
  });
});
