import { inconsistentWallets } from '@test/support/invariants';
import { queueDepth } from '@test/support/sqs';
import type { AppProcess, Storage } from './cluster';
import {
  type Sample,
  histogramQuantile,
  parsePrometheus,
  subtract,
  sumOf,
} from './prometheus';
import type { ConsistencyResult, Quantiles, ServerResult } from './types';

export async function scrape(
  processes: readonly AppProcess[],
): Promise<Sample[]> {
  const texts = await Promise.all(
    processes.map((app) =>
      fetch(`${app.url}/metrics`, { signal: AbortSignal.timeout(5000) })
        .then((response) => response.text())
        .catch(() => ''),
    ),
  );
  return texts.flatMap(parsePrometheus);
}

export class Sampler {
  maxOutboxAgeSeconds = 0;
  maxOutboxPending = 0;
  maxConnections = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;

  constructor(
    private readonly workers: () => readonly AppProcess[],
    private readonly storage: Storage,
  ) {}

  start(intervalMs = 1000): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      const [samples, connections] = await Promise.all([
        scrape(this.workers()),
        this.storage
          .sql`select count(*)::int as count from pg_stat_activity where datname = ${this.storage.databaseName}`
          .then((rows: { count: number }[]) => rows[0]?.count ?? 0)
          .catch(() => 0),
      ]);
      for (const sample of samples) {
        if (sample.name === 'outbox_oldest_pending_age_seconds') {
          this.maxOutboxAgeSeconds = Math.max(
            this.maxOutboxAgeSeconds,
            sample.value,
          );
        }
        if (sample.name === 'outbox_pending_events') {
          this.maxOutboxPending = Math.max(this.maxOutboxPending, sample.value);
        }
      }
      this.maxConnections = Math.max(this.maxConnections, connections);
    } finally {
      this.busy = false;
    }
  }
}

function quantilesOf(
  samples: readonly Sample[],
  name: string,
  labels: Record<string, string> = {},
): Quantiles {
  return {
    p50: histogramQuantile(samples, name, 0.5, labels),
    p95: histogramQuantile(samples, name, 0.95, labels),
    p99: histogramQuantile(samples, name, 0.99, labels),
  };
}

export function serverResult(
  before: readonly Sample[],
  after: readonly Sample[],
  sampler: Sampler,
): ServerResult {
  const delta = subtract(after, before);
  const transactions = new Map<string, number>();
  for (const sample of delta) {
    if (sample.name === 'wager_transactions_total' && sample.value > 0) {
      const key = `${sample.labels.channel}|${sample.labels.status}`;
      transactions.set(key, (transactions.get(key) ?? 0) + sample.value);
    }
  }
  const channels = new Set(
    delta
      .filter(
        (sample) =>
          sample.name === 'wager_processing_duration_seconds_count' &&
          sample.value > 0,
      )
      .map((sample) => sample.labels.channel ?? ''),
  );
  return {
    transactions: [...transactions.entries()]
      .map(([key, count]) => {
        const [channel = '', status = ''] = key.split('|');
        return { channel, status, count };
      })
      .sort((left, right) =>
        `${left.channel}${left.status}`.localeCompare(
          `${right.channel}${right.status}`,
        ),
      ),
    replays: sumOf(delta, 'idempotency_replays_total'),
    conflicts: sumOf(delta, 'idempotency_conflicts_total'),
    inboxDuplicates: sumOf(delta, 'inbox_duplicates_total'),
    dbRetries: sumOf(delta, 'db_transaction_retries_total'),
    lockTimeouts: sumOf(delta, 'wallet_lock_timeouts_total'),
    versionConflicts: sumOf(delta, 'wallet_version_conflicts_total'),
    sqsRetries: sumOf(delta, 'sqs_message_retries_total'),
    deadLettered: sumOf(delta, 'sqs_messages_dead_lettered_total'),
    lockWait: quantilesOf(delta, 'wallet_lock_wait_seconds'),
    processing: Object.fromEntries(
      [...channels]
        .sort()
        .map((channel) => [
          channel,
          quantilesOf(delta, 'wager_processing_duration_seconds', { channel }),
        ]),
    ),
    outboxDelay: quantilesOf(delta, 'outbox_publish_delay_seconds'),
    maxOutboxAgeSeconds: sampler.maxOutboxAgeSeconds,
    maxOutboxPending: sampler.maxOutboxPending,
    maxConnections: sampler.maxConnections,
  };
}

async function count(storage: Storage, query: string): Promise<number> {
  const [row] = await storage.sql.unsafe(query);
  return (row as { count: number } | undefined)?.count ?? 0;
}

const unpublishedEvents = (storage: Storage) =>
  count(
    storage,
    'select count(*)::int as count from outbox_messages where published_at is null',
  );

const pendingReferences = (storage: Storage) =>
  count(
    storage,
    "select count(*)::int as count from wager_transactions where status = 'PENDING_REFERENCE'",
  );

export async function waitForDrain(
  storage: Storage,
  timeoutMs: number,
): Promise<{ drained: boolean; seconds: number }> {
  const started = performance.now();
  for (;;) {
    const [commands, unpublished, pending] = await Promise.all([
      queueDepth(storage.sqs, storage.queues.commands),
      unpublishedEvents(storage),
      pendingReferences(storage),
    ]);
    const seconds = (performance.now() - started) / 1000;
    if (commands === 0 && unpublished === 0 && pending === 0) {
      return { drained: true, seconds };
    }
    if (seconds * 1000 > timeoutMs) {
      return { drained: false, seconds };
    }
    await Bun.sleep(250);
  }
}

export async function consistencyOf(
  storage: Storage,
  drain: { drained: boolean; seconds: number },
): Promise<ConsistencyResult> {
  const [wallets, violations, dlqDepth, unpublished, pending] =
    await Promise.all([
      count(storage, 'select count(*)::int as count from wallets'),
      inconsistentWallets(storage.sql),
      queueDepth(storage.sqs, storage.queues.deadLetter),
      unpublishedEvents(storage),
      pendingReferences(storage),
    ]);
  return {
    wallets,
    violations,
    drained: drain.drained,
    drainSeconds: drain.seconds,
    dlqDepth,
    unpublished,
    pendingReferences: pending,
  };
}

export async function processedAt(
  storage: Storage,
): Promise<Map<string, number>> {
  const rows: { message_id: string; processed_ms: number }[] =
    await storage.sql`select message_id, (extract(epoch from processed_at) * 1000)::float8 as processed_ms from inbox_messages where processed_at is not null`;
  return new Map(rows.map((row) => [row.message_id, Number(row.processed_ms)]));
}
