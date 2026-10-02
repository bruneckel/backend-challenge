import type { OutboxMessage } from '@messaging/domain/outbox-message';
import type { Clock } from '@shared/application/clock';
import type { UnitOfWork } from '@shared/application/unit-of-work';
import type { ExponentialBackoff } from '@shared/domain/exponential-backoff';
import type { EventPublisher, PublishReport } from './ports/event-publisher';
import type { OutboxScope } from './ports/outbox-scope';

export interface PublishOutboxBatchDependencies {
  unitOfWork: UnitOfWork<OutboxScope>;
  publisher: EventPublisher;
  clock: Clock;
  retryBackoff: ExponentialBackoff;
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

  execute(): Promise<PublicationSummary> {
    return this.deps.unitOfWork.run(async ({ outbox }) => {
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
        } else {
          message.scheduleRetry(
            at,
            this.deps.retryBackoff,
            reasons.get(message.id) ?? UNCONFIRMED,
          );
        }
        await outbox.save(message);
      }
      return {
        claimed: batch.length,
        published: publishedCount,
        retried: batch.length - publishedCount,
      };
    });
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
