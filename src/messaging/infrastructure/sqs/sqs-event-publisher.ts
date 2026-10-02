import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishReport } from '@messaging/application/ports/event-publisher';
import type { OutboxMessage } from '@messaging/domain/outbox-message';

export type QueueUrlSource = string | (() => Promise<string>);

export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: QueueUrlSource,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishReport> {
    const response = await this.client.send(
      new SendMessageBatchCommand({
        QueueUrl: typeof this.queueUrl === 'string' ? this.queueUrl : await this.queueUrl(),
        Entries: messages.map((message) => ({
          Id: message.id,
          MessageBody: JSON.stringify(message.payload),
          MessageGroupId: message.messageGroupId,
          MessageDeduplicationId: message.id,
          MessageAttributes: {
            eventType: { DataType: 'String', StringValue: message.eventType },
            eventVersion: { DataType: 'Number', StringValue: String(message.eventVersion) },
          },
        })),
      }),
    );
    return {
      published: (response.Successful ?? []).flatMap((entry) => (entry.Id === undefined ? [] : [entry.Id])),
      failed: (response.Failed ?? []).flatMap((entry) =>
        entry.Id === undefined ? [] : [{ messageId: entry.Id, reason: `${entry.Code ?? 'Failed'}: ${entry.Message ?? ''}` }],
      ),
    };
  }
}
