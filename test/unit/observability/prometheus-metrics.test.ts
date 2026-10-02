import { describe, expect, test } from 'bun:test';
import { PrometheusMetrics } from '@observability/metrics/prometheus-metrics';

const exposition = (metrics: PrometheusMetrics) => metrics.registry.metrics();

describe('PrometheusMetrics', () => {
  test('exposes every catalog metric with the role and instance of the process', async () => {
    const metrics = new PrometheusMetrics({ role: 'api', instance: 'api-1' });

    const text = await exposition(metrics);

    for (const name of [
      'wager_transactions_total',
      'idempotency_replays_total',
      'idempotency_conflicts_total',
      'inbox_duplicates_total',
      'sqs_message_retries_total',
      'db_transaction_retries_total',
      'outbox_publish_retries_total',
      'pending_reference_retries_total',
      'sqs_messages_dead_lettered_total',
      'sqs_dlq_approximate_messages',
      'wallet_lock_wait_seconds',
      'wallet_lock_timeouts_total',
      'db_deadlocks_total',
      'wallet_version_conflicts_total',
      'outbox_pending_events',
      'outbox_oldest_pending_age_seconds',
      'outbox_publish_delay_seconds',
      'pending_reference_transactions',
      'wager_processing_duration_seconds',
      'http_request_duration_seconds',
      'wallet_reconciliations_total',
      'wallet_reconciliation_divergences_total',
    ]) {
      expect(text).toContain(`# TYPE ${name} `);
    }
  });

  test('counts, observes and sets values with their labels', async () => {
    const metrics = new PrometheusMetrics({ role: 'worker', instance: 'w-1' });

    metrics.increment('wager_transactions_total', {
      kind: 'BET',
      status: 'PROCESSED',
      channel: 'http',
    });
    metrics.increment('outbox_publish_retries_total', {}, 3);
    metrics.observe('wallet_lock_wait_seconds', 0.02);
    metrics.set('outbox_pending_events', 7);

    const text = await exposition(metrics);
    expect(text).toContain(
      'wager_transactions_total{kind="BET",status="PROCESSED",channel="http",role="worker",instance="w-1"} 1',
    );
    expect(text).toContain(
      'outbox_publish_retries_total{role="worker",instance="w-1"} 3',
    );
    expect(text).toContain(
      'wallet_lock_wait_seconds_count{role="worker",instance="w-1"} 1',
    );
    expect(text).toContain(
      'outbox_pending_events{role="worker",instance="w-1"} 7',
    );
  });

  test('refuses labels that the metric does not declare', () => {
    const metrics = new PrometheusMetrics({ role: 'api', instance: 'api-1' });

    expect(() =>
      metrics.increment('inbox_duplicates_total', { playerId: 'p-1' }),
    ).toThrow();
  });
});
