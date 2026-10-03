import type { OutboxMessage } from '@messaging/domain/outbox-message';
import type { Clock } from '@shared/application/clock';
import type { Metrics } from '@shared/application/metrics';
import type { UnitOfWork } from '@shared/application/unit-of-work';
import type { ExponentialBackoff } from '@shared/domain/exponential-backoff';
import type { EventPublisher, PublishReport } from './ports/event-publisher';
import type { OutboxScope } from './ports/outbox-scope';

export interface PublishOutboxBatchDependencies {
  unitOfWork: UnitOfWork<OutboxScope>;
  publisher: EventPublisher;
  clock: Clock;
  retryBackoff: ExponentialBackoff;
  metrics: Metrics;
  batchSize: number;
}

export interface PublicationSummary {
  claimed: number;
  published: number;
  retried: number;
}

const UNCONFIRMED = 'The broker did not confirm this entry';

export class PublishOutboxBatch {
  constructor(private readonly deps: PublishOutboxBatchDependencies) {}

  async execute(): Promise<PublicationSummary> {
    const delays: number[] = [];
    const summary = await this.deps.unitOfWork.run(async ({ outbox }) => {
      const batch = await outbox.claimDueBatch(
        this.deps.clock.now(),
        this.deps.batchSize,
      );
      if (batch.length === 0) {
        return { claimed: 0, published: 0, retried: 0 };
      }
      const report = await this.publish(batch);
      const at = this.deps.clock.now();
      const published = new Set(report.published);
      const reasons = new Map(
        report.failed.map((failure) => [failure.messageId, failure.reason]),
      );
      let publishedCount = 0;
      for (const message of batch) {
        if (published.has(message.id)) {
          message.markPublished(at);
          publishedCount += 1;
          delays.push((at.getTime() - message.occurredAt.getTime()) / 1000);
        } else {
          message.scheduleRetry(
            at,
            this.deps.retryBackoff,
            reasons.get(message.id) ?? UNCONFIRMED,
          );
        }
      }
      await outbox.saveAll(batch);
      return {
        claimed: batch.length,
        published: publishedCount,
        retried: batch.length - publishedCount,
      };
    });
    if (summary.retried > 0) {
      this.deps.metrics.increment(
        'outbox_publish_retries_total',
        {},
        summary.retried,
      );
    }
    for (const delay of delays) {
      this.deps.metrics.observe('outbox_publish_delay_seconds', delay);
    }
    return summary;
  }

  private async publish(
    batch: readonly OutboxMessage[],
  ): Promise<PublishReport> {
    try {
      return await this.deps.publisher.publish(batch);
    } catch (error) {
      const reason =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
      return {
        published: [],
        failed: batch.map((message) => ({ messageId: message.id, reason })),
      };
    }
  }
}
