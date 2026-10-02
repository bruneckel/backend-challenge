import { type InferEntity, defineEntity, p } from '@mikro-orm/core';
import { OutboxMessage } from '@messaging/domain/outbox-message';

export const OutboxMessageRecord = defineEntity({
  name: 'OutboxMessageRecord',
  tableName: 'outbox_messages',
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.uuid(),
    eventType: p.text(),
    eventVersion: p.integer(),
    messageGroupId: p.text(),
    payload: p.json<Record<string, unknown>>(),
    occurredAt: p.datetime().columnType('timestamptz'),
    attempts: p.integer(),
    nextAttemptAt: p.datetime().columnType('timestamptz'),
    publishedAt: p.datetime().columnType('timestamptz').nullable(),
    lastError: p.text().nullable(),
  },
});

export type OutboxMessageRow = InferEntity<typeof OutboxMessageRecord>;

export type OutboxDelivery = Pick<
  OutboxMessageRow,
  'attempts' | 'nextAttemptAt' | 'publishedAt' | 'lastError'
>;

export function toOutboxDelivery(message: OutboxMessage): OutboxDelivery {
  const state = message.toState();
  return {
    attempts: state.attempts,
    nextAttemptAt: state.nextAttemptAt,
    publishedAt: state.publishedAt ?? null,
    lastError: state.lastError ?? null,
  };
}

export function toOutboxMessageRow(message: OutboxMessage): OutboxMessageRow {
  const state = message.toState();
  return {
    id: state.id,
    aggregateId: state.aggregateId,
    eventType: state.eventType,
    eventVersion: state.eventVersion,
    messageGroupId: state.messageGroupId,
    payload: { ...state.payload },
    occurredAt: state.occurredAt,
    ...toOutboxDelivery(message),
  };
}

export function toOutboxMessage(row: OutboxMessageRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregateId,
    eventType: row.eventType,
    eventVersion: row.eventVersion,
    messageGroupId: row.messageGroupId,
    payload: Object.freeze({ ...row.payload }),
    occurredAt: row.occurredAt,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    publishedAt: row.publishedAt ?? undefined,
    lastError: row.lastError ?? undefined,
  });
}
