import type { Clock } from '@shared/application/clock';
import type { Metrics } from '@shared/application/metrics';
import type { UnitOfWork } from '@shared/application/unit-of-work';
import type { PurgedBatch } from './ports/purged-batch';
import type { RetentionScope } from './ports/retention-scope';

export interface RetentionSettings {
  outboxRetentionHours: number;
  inboxRetentionHours: number;
  batchSize: number;
}

export interface PurgeExpiredMessagesDependencies {
  unitOfWork: UnitOfWork<RetentionScope>;
  clock: Clock;
  metrics: Metrics;
  settings: RetentionSettings;
}

export interface PurgeResult {
  outbox: number;
  inbox: number;
}

const HOUR_MS = 3_600_000;

export class PurgeExpiredMessages {
  private outboxAfter: string | undefined;
  private inboxFrom: Date | undefined;

  constructor(private readonly deps: PurgeExpiredMessagesDependencies) {}

  async execute(): Promise<PurgeResult> {
    const { clock, metrics, settings, unitOfWork } = this.deps;
    const now = clock.now().getTime();
    const outbox = await unitOfWork.run(({ outbox: events }) =>
      events.deletePublishedBefore(
        new Date(now - settings.outboxRetentionHours * HOUR_MS),
        settings.batchSize,
        this.outboxAfter,
      ),
    );
    this.outboxAfter = this.nextPosition(outbox);
    const inbox = await unitOfWork.run(({ inbox: messages }) =>
      messages.deleteProcessedBefore(
        new Date(now - settings.inboxRetentionHours * HOUR_MS),
        settings.batchSize,
        this.inboxFrom,
      ),
    );
    this.inboxFrom = this.nextPosition(inbox);
    if (outbox.count > 0) {
      metrics.increment('outbox_events_purged_total', {}, outbox.count);
    }
    if (inbox.count > 0) {
      metrics.increment('inbox_messages_purged_total', {}, inbox.count);
    }
    return { outbox: outbox.count, inbox: inbox.count };
  }

  private nextPosition<TPosition>(
    batch: PurgedBatch<TPosition>,
  ): TPosition | undefined {
    return batch.count === this.deps.settings.batchSize
      ? batch.last
      : undefined;
  }
}
