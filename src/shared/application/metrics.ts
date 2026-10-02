export type CounterName =
  | 'wager_transactions_total'
  | 'idempotency_replays_total'
  | 'idempotency_conflicts_total'
  | 'inbox_duplicates_total'
  | 'sqs_message_retries_total'
  | 'db_transaction_retries_total'
  | 'outbox_publish_retries_total'
  | 'pending_reference_retries_total'
  | 'sqs_messages_dead_lettered_total'
  | 'wallet_lock_timeouts_total'
  | 'db_deadlocks_total'
  | 'wallet_version_conflicts_total'
  | 'wallet_reconciliations_total'
  | 'wallet_reconciliation_divergences_total';

export type GaugeName =
  | 'pending_reference_transactions'
  | 'sqs_dlq_approximate_messages'
  | 'outbox_pending_events'
  | 'outbox_oldest_pending_age_seconds';

export type HistogramName =
  | 'wallet_lock_wait_seconds'
  | 'outbox_publish_delay_seconds'
  | 'wager_processing_duration_seconds'
  | 'http_request_duration_seconds';

export type MetricLabels = Readonly<Record<string, string>>;

export type Channel = 'http' | 'sqs' | 'worker';

export interface Metrics {
  increment(name: CounterName, labels?: MetricLabels, value?: number): void;
  observe(name: HistogramName, value: number, labels?: MetricLabels): void;
  set(name: GaugeName, value: number, labels?: MetricLabels): void;
}

export const noopMetrics: Metrics = {
  increment() {},
  observe() {},
  set() {},
};
