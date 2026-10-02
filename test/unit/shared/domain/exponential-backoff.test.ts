import { describe, expect, test } from 'bun:test';
import { ExponentialBackoff } from '@shared/domain/exponential-backoff';

describe('ExponentialBackoff', () => {
  test('doubles from the base delay until it reaches the cap', () => {
    const backoff = ExponentialBackoff.create({ baseMs: 2_000, maxMs: 120_000, random: () => 1 });

    const delays = [1, 2, 3, 4, 5, 6, 7, 8].map((attempt) => backoff.delayFor(attempt));

    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 120_000, 120_000]);
  });

  test('applies jitter between half of the delay and the full delay', () => {
    const lowest = ExponentialBackoff.create({ baseMs: 2_000, maxMs: 120_000, random: () => 0 });
    const middle = ExponentialBackoff.create({ baseMs: 2_000, maxMs: 120_000, random: () => 0.5 });

    expect(lowest.delayFor(3)).toBe(4_000);
    expect(middle.delayFor(3)).toBe(6_000);
  });

  test('keeps the default random jitter inside the expected range', () => {
    const backoff = ExponentialBackoff.create({ baseMs: 1_000, maxMs: 60_000 });

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const full = Math.min(1_000 * 2 ** (attempt - 1), 60_000);
      const delay = backoff.delayFor(attempt);
      expect(delay).toBeGreaterThanOrEqual(full / 2);
      expect(delay).toBeLessThanOrEqual(full);
    }
  });

  test('uses a custom growth factor', () => {
    const backoff = ExponentialBackoff.create({ baseMs: 1_000, maxMs: 100_000, factor: 3, random: () => 1 });

    expect(backoff.delayFor(3)).toBe(9_000);
  });

  test('stays at the cap for very large attempt numbers', () => {
    const backoff = ExponentialBackoff.create({ baseMs: 1_000, maxMs: 300_000, random: () => 1 });

    expect(backoff.delayFor(10_000)).toBe(300_000);
  });

  test('schedules the next attempt from a given instant', () => {
    const backoff = ExponentialBackoff.create({ baseMs: 2_000, maxMs: 120_000, random: () => 1 });

    const next = backoff.nextAttemptAt(new Date('2026-10-02T12:00:00.000Z'), 2);

    expect(next.toISOString()).toBe('2026-10-02T12:00:04.000Z');
  });

  test.each([0, -1, 1.5, Number.NaN])('rejects the attempt number %p', (attempt) => {
    const backoff = ExponentialBackoff.create({ baseMs: 1_000, maxMs: 10_000 });

    expect(() => backoff.delayFor(attempt)).toThrow(RangeError);
  });

  test('rejects an invalid configuration', () => {
    expect(() => ExponentialBackoff.create({ baseMs: 0, maxMs: 10_000 })).toThrow(RangeError);
    expect(() => ExponentialBackoff.create({ baseMs: 10_000, maxMs: 5_000 })).toThrow(RangeError);
    expect(() => ExponentialBackoff.create({ baseMs: 1_000, maxMs: 10_000, factor: 0.5 })).toThrow(RangeError);
  });
});
