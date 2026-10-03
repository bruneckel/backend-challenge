import { describe, expect, test } from 'bun:test';
import { Timeline, percentile, summarize } from '@test/load/stats';

describe('percentile', () => {
  test('uses the nearest rank of a sorted sample', () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);

    expect(percentile(values, 0.5)).toBe(50);
    expect(percentile(values, 0.95)).toBe(95);
    expect(percentile(values, 0.99)).toBe(99);
    expect(percentile(values, 1)).toBe(100);
  });

  test('answers NaN for an empty sample', () => {
    expect(percentile([], 0.5)).toBeNaN();
  });
});

describe('summarize', () => {
  test('sorts the sample and reports count, mean and percentiles', () => {
    expect(summarize([30, 10, 20, 40])).toEqual({
      count: 4,
      mean: 25,
      min: 10,
      p50: 20,
      p90: 40,
      p95: 40,
      p99: 40,
      max: 40,
    });
  });

  test('reports an empty sample with zero count and NaN statistics', () => {
    const summary = summarize([]);

    expect(summary.count).toBe(0);
    expect(summary.p99).toBeNaN();
  });
});

describe('Timeline', () => {
  test('groups completions by second since the start', () => {
    const timeline = new Timeline(1_000);
    timeline.record(1_100, 10, true);
    timeline.record(1_900, 30, false);
    timeline.record(3_050, 20, true);

    expect(timeline.buckets()).toEqual([
      { second: 0, completed: 2, ok: 1, failed: 1, p50: 10, p99: 30 },
      { second: 1, completed: 0, ok: 0, failed: 0, p50: NaN, p99: NaN },
      { second: 2, completed: 1, ok: 1, failed: 0, p50: 20, p99: 20 },
    ]);
  });
});
