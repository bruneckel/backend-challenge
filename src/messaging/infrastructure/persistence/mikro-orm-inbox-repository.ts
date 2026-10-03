import type { EntityManager } from '@mikro-orm/postgresql';
import type {
  InboxRecording,
  InboxRepository,
} from '@messaging/application/ports/inbox-repository';
import type { PurgedBatch } from '@messaging/application/ports/purged-batch';
import type { InboxMessage } from '@messaging/domain/inbox-message';
import {
  InboxMessageRecord,
  toInboxMessage,
  toInboxMessageRow,
} from './inbox-message-record';

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async record(message: InboxMessage): Promise<InboxRecording> {
    const result = await this.em
      .createQueryBuilder(InboxMessageRecord)
      .insert(toInboxMessageRow(message, undefined))
      .onConflict(['consumerName', 'messageId'])
      .ignore()
      .execute();
    if (result.affectedRows === 1) {
      return { recorded: true };
    }
    const existing = await this.em.findOneOrFail(
      InboxMessageRecord,
      { consumerName: message.consumerName, messageId: message.messageId },
      { disableIdentityMap: true },
    );
    return { recorded: false, existing: toInboxMessage(existing) };
  }

  async deleteProcessedBefore(
    cutoff: Date,
    limit: number,
    from?: Date,
  ): Promise<PurgedBatch<Date>> {
    const rows = await this.em.execute<{ received_ms: number }[]>(
      `delete from inbox_messages
        where (consumer_name, message_id) in (
          select consumer_name, message_id from inbox_messages
           where received_at >= coalesce(?::timestamptz, '-infinity')
             and received_at < ? and processed_at is not null
           order by received_at
           limit ?
           for update skip locked)
        returning floor(extract(epoch from received_at) * 1000)::float8 as received_ms`,
      [from ?? null, cutoff, limit],
      'all',
    );
    const last = rows.reduce(
      (latest, row) => Math.max(latest, row.received_ms),
      Number.NEGATIVE_INFINITY,
    );
    return {
      count: rows.length,
      last: rows.length === 0 ? undefined : new Date(last),
    };
  }

  async saveProcessed(
    message: InboxMessage,
    transactionId: string | undefined,
  ): Promise<void> {
    await this.em.nativeUpdate(
      InboxMessageRecord,
      { consumerName: message.consumerName, messageId: message.messageId },
      {
        processedAt: message.processedAt ?? null,
        transactionId: transactionId ?? null,
      },
    );
  }
}
