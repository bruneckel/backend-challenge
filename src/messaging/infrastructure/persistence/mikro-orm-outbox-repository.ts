import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxRepository } from '@messaging/application/ports/outbox-repository';
import type { OutboxMessage } from '@messaging/domain/outbox-message';
import {
  OutboxMessageRecord,
  toOutboxDelivery,
  toOutboxMessage,
  toOutboxMessageRow,
} from './outbox-message-record';

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length > 0) {
      await this.em.insertMany(
        OutboxMessageRecord,
        messages.map(toOutboxMessageRow),
      );
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

  async saveAll(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    const rows = messages.map(
      () => '(?::uuid, ?::timestamptz, ?::int, ?::timestamptz, ?::text)',
    );
    const params = messages.flatMap((message) => {
      const delivery = toOutboxDelivery(message);
      return [
        message.id,
        delivery.publishedAt,
        delivery.attempts,
        delivery.nextAttemptAt,
        delivery.lastError,
      ];
    });
    await this.em.execute(
      `update outbox_messages as o
          set published_at = v.published_at,
              attempts = v.attempts,
              next_attempt_at = v.next_attempt_at,
              last_error = v.last_error
         from (values ${rows.join(', ')}) as v(id, published_at, attempts, next_attempt_at, last_error)
        where o.id = v.id`,
      params,
    );
  }

  async save(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageRecord,
      { id: message.id },
      toOutboxDelivery(message),
    );
  }
}
