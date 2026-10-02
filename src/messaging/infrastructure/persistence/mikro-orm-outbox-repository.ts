import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxRepository } from '@messaging/application/ports/outbox-repository';
import type { OutboxMessage } from '@messaging/domain/outbox-message';
import { OutboxMessageRecord, toOutboxDelivery, toOutboxMessage, toOutboxMessageRow } from './outbox-message-record';

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length > 0) {
      await this.em.insertMany(OutboxMessageRecord, messages.map(toOutboxMessageRow));
    }
  }

  async claimDueBatch(now: Date, limit: number): Promise<OutboxMessage[]> {
    const rows = await this.em.find(
      OutboxMessageRecord,
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      {
        orderBy: { nextAttemptAt: 'asc', id: 'asc' },
        limit,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        disableIdentityMap: true,
      },
    );
    return rows.map(toOutboxMessage);
  }

  async save(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(OutboxMessageRecord, { id: message.id }, toOutboxDelivery(message));
  }
}
