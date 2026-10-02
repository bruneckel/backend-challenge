import type { OutboxMessage } from '@messaging/domain/outbox-message';

export interface OutboxRepository {
  enqueue(messages: readonly OutboxMessage[]): Promise<void>;
  claimDueBatch(now: Date, limit: number): Promise<OutboxMessage[]>;
  save(message: OutboxMessage): Promise<void>;
}
