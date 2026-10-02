import type { OutboxMessage } from '@messaging/domain/outbox-message';

export interface PublishFailure {
  messageId: string;
  reason: string;
}

export interface PublishReport {
  published: string[];
  failed: PublishFailure[];
}

export interface EventPublisher {
  publish(messages: readonly OutboxMessage[]): Promise<PublishReport>;
}
