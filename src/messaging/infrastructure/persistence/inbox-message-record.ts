import { type InferEntity, defineEntity, p } from '@mikro-orm/core';
import { InboxMessage } from '@messaging/domain/inbox-message';

export const InboxMessageRecord = defineEntity({
  name: 'InboxMessageRecord',
  tableName: 'inbox_messages',
  properties: {
    consumerName: p.text().primary(),
    messageId: p.text().primary(),
    payloadHash: p.text(),
    transactionId: p.uuid().nullable(),
    receivedAt: p.datetime().columnType('timestamptz'),
    processedAt: p.datetime().columnType('timestamptz').nullable(),
  },
});

export type InboxMessageRow = InferEntity<typeof InboxMessageRecord>;

export function toInboxMessageRow(message: InboxMessage, transactionId: string | undefined): InboxMessageRow {
  return {
    consumerName: message.consumerName,
    messageId: message.messageId,
    payloadHash: message.payloadHash,
    transactionId: transactionId ?? null,
    receivedAt: message.receivedAt,
    processedAt: message.processedAt ?? null,
  };
}

export function toInboxMessage(row: InboxMessageRow): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: row.consumerName,
    messageId: row.messageId,
    payloadHash: row.payloadHash,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt ?? undefined,
  });
}
