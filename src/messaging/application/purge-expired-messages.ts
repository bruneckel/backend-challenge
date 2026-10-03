import type { Clock } from '@shared/application/clock';
import type { Metrics } from '@shared/application/metrics';
import type { UnitOfWork } from '@shared/application/unit-of-work';
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
  constructor(private readonly deps: PurgeExpiredMessagesDependencies) {}

  async execute(): Promise<PurgeResult> {
    const { clock, metrics, settings, unitOfWork } = this.deps;
    const now = clock.now().getTime();
    const outbox = await unitOfWork.run(({ outbox: events }) =>
      events.deletePublishedBefore(
        new Date(now - settings.outboxRetentionHours * HOUR_MS),
        settings.batchSize,
      ),
    );
    const inbox = await unitOfWork.run(({ inbox: messages }) =>
      messages.deleteProcessedBefore(
        new Date(now - settings.inboxRetentionHours * HOUR_MS),
        settings.batchSize,
      ),
    );
    if (outbox > 0) {
      metrics.increment('outbox_events_purged_total', {}, outbox);
    }
    if (inbox > 0) {
      metrics.increment('inbox_messages_purged_total', {}, inbox);
    }
    return { outbox, inbox };
  }
}
