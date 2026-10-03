import { describe, expect, test } from 'bun:test';
import {
  histogramQuantile,
  parsePrometheus,
  subtract,
  sumOf,
} from '@test/load/prometheus';

const exposition = `# HELP wager_transactions_total Wager transactions settled
# TYPE wager_transactions_total counter
wager_transactions_total{kind="BET",status="PROCESSED",channel="http",role="api",instance="a"} 7
wager_transactions_total{kind="WIN",status="PROCESSED",channel="sqs",role="worker",instance="w"} 3
wager_transactions_total{kind="BET",status="REJECTED",channel="http",role="api",instance="a"} 1
# TYPE wallet_lock_wait_seconds histogram
wallet_lock_wait_seconds_bucket{role="api",instance="a",le="0.001"} 0
wallet_lock_wait_seconds_bucket{role="api",instance="a",le="0.01"} 50
wallet_lock_wait_seconds_bucket{role="api",instance="a",le="0.1"} 90
wallet_lock_wait_seconds_bucket{role="api",instance="a",le="+Inf"} 100
wallet_lock_wait_seconds_sum{role="api",instance="a"} 2.5
wallet_lock_wait_seconds_count{role="api",instance="a"} 100
outbox_pending_events{role="worker",instance="w"} 4
label_with_quotes{note="say \\"hi\\""} 1.5e3
`;

describe('parsePrometheus', () => {
  test('reads names, labels and values and skips comments', () => {
    const samples = parsePrometheus(exposition);

    expect(samples).toContainEqual({
      name: 'outbox_pending_events',
      labels: { role: 'worker', instance: 'w' },
      value: 4,
    });
    expect(samples).toContainEqual({
      name: 'label_with_quotes',
      labels: { note: 'say "hi"' },
      value: 1500,
    });
    expect(samples.some((sample) => sample.name.startsWith('#'))).toBe(false);
  });
});

describe('sumOf', () => {
  test('adds every series of a metric that carries the given labels', () => {
    const samples = parsePrometheus(exposition);

    expect(sumOf(samples, 'wager_transactions_total')).toBe(11);
    expect(
      sumOf(samples, 'wager_transactions_total', { status: 'PROCESSED' }),
    ).toBe(10);
    expect(sumOf(samples, 'missing_metric')).toBe(0);
  });
});

describe('subtract', () => {
  test('returns the growth of each series between two scrapes', () => {
    const before = parsePrometheus('requests_total{route="/a"} 5\n');
    const after = parsePrometheus(
      'requests_total{route="/a"} 12\nrequests_total{route="/b"} 3\n',
    );

    expect(subtract(after, before)).toEqual([
      { name: 'requests_total', labels: { route: '/a' }, value: 7 },
      { name: 'requests_total', labels: { route: '/b' }, value: 3 },
    ]);
  });
});

describe('histogramQuantile', () => {
  test('interpolates inside the bucket that holds the quantile, like PromQL', () => {
    const samples = parsePrometheus(exposition);

    expect(
      histogramQuantile(samples, 'wallet_lock_wait_seconds', 0.5),
    ).toBeCloseTo(0.01, 6);
    expect(
      histogramQuantile(samples, 'wallet_lock_wait_seconds', 0.7),
    ).toBeCloseTo(0.055, 6);
  });

  test('answers the highest finite bound when the quantile falls in +Inf', () => {
    const samples = parsePrometheus(exposition);

    expect(histogramQuantile(samples, 'wallet_lock_wait_seconds', 0.99)).toBe(
      0.1,
    );
  });

  test('answers undefined when the histogram has no observations', () => {
    expect(histogramQuantile([], 'wallet_lock_wait_seconds', 0.5)).toBe(
      undefined,
    );
  });
});
