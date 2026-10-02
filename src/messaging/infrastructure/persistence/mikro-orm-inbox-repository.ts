import type { EntityManager } from '@mikro-orm/postgresql';
import type {
  InboxRecording,
  InboxRepository,
} from '@messaging/application/ports/inbox-repository';
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
