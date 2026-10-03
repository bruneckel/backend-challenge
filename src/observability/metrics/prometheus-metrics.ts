import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type {
  CounterName,
  GaugeName,
  HistogramName,
  MetricLabels,
  Metrics,
} from '@shared/application/metrics';

interface Definition {
  help: string;
  labelNames: readonly string[];
}

interface HistogramDefinition extends Definition {
  buckets: readonly number[];
}

const LATENCY_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

const COUNTERS: Record<CounterName, Definition> = {
  wager_transactions_total: {
    help: 'Wager transactions settled, by kind, final status and channel',
    labelNames: ['kind', 'status', 'channel'],
  },
  idempotency_replays_total: {
    help: 'Requests answered as idempotent replays',
    labelNames: ['channel'],
  },
  idempotency_conflicts_total: {
    help: 'Requests refused because a key, external id or message id was reused with another payload',
    labelNames: ['channel', 'type'],
  },
  inbox_duplicates_total: {
    help: 'SQS deliveries recognised as duplicates by the inbox',
    labelNames: [],
  },
  sqs_message_retries_total: {
    help: 'SQS messages scheduled for another attempt',
    labelNames: ['reason'],
  },
  db_transaction_retries_total: {
    help: 'Units of work re-run after a database conflict',
    labelNames: ['sqlstate'],
  },
  outbox_publish_retries_total: {
    help: 'Outbox events scheduled for another publication attempt',
    labelNames: [],
  },
  pending_reference_retries_total: {
    help: 'Waiting transactions scheduled for another reference check',
    labelNames: [],
  },
  sqs_messages_dead_lettered_total: {
    help: 'SQS messages moved to the dead-letter queue',
    labelNames: ['reason'],
  },
  wallet_lock_timeouts_total: {
    help: 'Units of work that gave up waiting for a lock',
    labelNames: [],
  },
  db_deadlocks_total: {
    help: 'Units of work aborted by a deadlock',
    labelNames: [],
  },
  wallet_version_conflicts_total: {
    help: 'Wallet updates refused because the version moved (expected to stay at zero)',
    labelNames: [],
  },
  wallet_reconciliations_total: {
    help: 'Wallet reconciliations, by result',
    labelNames: ['result'],
  },
  wallet_reconciliation_divergences_total: {
    help: 'Divergences found by wallet reconciliations: balance, ledger chain or version',
    labelNames: ['kind'],
  },
  wallet_events_streamed_total: {
    help: 'Ledger entries written to wallet event streams',
    labelNames: [],
  },
  outbox_events_purged_total: {
    help: 'Published outbox events deleted after the retention period',
    labelNames: [],
  },
  inbox_messages_purged_total: {
    help: 'Processed inbox messages deleted after the retention period',
    labelNames: [],
  },
};

const GAUGES: Record<GaugeName, Definition> = {
  pending_reference_transactions: {
    help: 'Transactions waiting for their reference',
    labelNames: [],
  },
  sqs_dlq_approximate_messages: {
    help: 'Approximate number of messages in the dead-letter queue',
    labelNames: [],
  },
  outbox_pending_events: {
    help: 'Outbox events not yet published',
    labelNames: [],
  },
  outbox_oldest_pending_age_seconds: {
    help: 'Age of the oldest outbox event not yet published',
    labelNames: [],
  },
  wallet_event_streams: {
    help: 'Wallet event streams open on this instance',
    labelNames: [],
  },
};

const HISTOGRAMS: Record<HistogramName, HistogramDefinition> = {
  wallet_lock_wait_seconds: {
    help: 'Time spent waiting for the wallet row lock',
    labelNames: [],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  },
  outbox_publish_delay_seconds: {
    help: 'Time between an event occurring and its publication',
    labelNames: [],
    buckets: [0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 300],
  },
  wager_processing_duration_seconds: {
    help: 'Time to process a wager transaction, by channel, kind and outcome',
    labelNames: ['channel', 'kind', 'outcome'],
    buckets: LATENCY_BUCKETS,
  },
  http_request_duration_seconds: {
    help: 'HTTP request duration, by method, route and status',
    labelNames: ['method', 'route', 'status'],
    buckets: LATENCY_BUCKETS,
  },
  wallet_event_delivery_seconds: {
    help: 'Time between a ledger entry being written and reaching an event stream',
    labelNames: [],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  },
};

export interface ProcessLabels {
  role: string;
  instance: string;
}

export class PrometheusMetrics implements Metrics {
  readonly registry = new Registry();
  private readonly counters = new Map<CounterName, Counter>();
  private readonly gauges = new Map<GaugeName, Gauge>();
  private readonly histograms = new Map<HistogramName, Histogram>();

  constructor(processLabels: ProcessLabels) {
    this.registry.setDefaultLabels({ ...processLabels });
    for (const [name, definition] of Object.entries(COUNTERS)) {
      this.counters.set(
        name as CounterName,
        new Counter({
          name,
          help: definition.help,
          labelNames: [...definition.labelNames],
          registers: [this.registry],
        }),
      );
    }
    for (const [name, definition] of Object.entries(GAUGES)) {
      this.gauges.set(
        name as GaugeName,
        new Gauge({
          name,
          help: definition.help,
          labelNames: [...definition.labelNames],
          registers: [this.registry],
        }),
      );
    }
    for (const [name, definition] of Object.entries(HISTOGRAMS)) {
      this.histograms.set(
        name as HistogramName,
        new Histogram({
          name,
          help: definition.help,
          labelNames: [...definition.labelNames],
          buckets: [...definition.buckets],
          registers: [this.registry],
        }),
      );
    }
  }

  increment(name: CounterName, labels: MetricLabels = {}, value = 1): void {
    this.counters.get(name)?.inc({ ...labels }, value);
  }

  observe(name: HistogramName, value: number, labels: MetricLabels = {}): void {
    this.histograms.get(name)?.observe({ ...labels }, value);
  }

  set(name: GaugeName, value: number, labels: MetricLabels = {}): void {
    this.gauges.get(name)?.set({ ...labels }, value);
  }
}
