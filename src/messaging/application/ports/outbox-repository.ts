import type { OutboxMessage } from '@messaging/domain/outbox-message';
import type { PurgedBatch } from './purged-batch';

export interface OutboxRepository {
  enqueue(messages: readonly OutboxMessage[]): Promise<void>;
  claimDueBatch(now: Date, limit: number): Promise<OutboxMessage[]>;
  save(message: OutboxMessage): Promise<void>;
  saveAll(messages: readonly OutboxMessage[]): Promise<void>;
  deletePublishedBefore(
    cutoff: Date,
    limit: number,
    after?: string,
  ): Promise<PurgedBatch<string>>;
}
