import {
  DeleteMessageCommand,
  DeleteQueueCommand,
  type Message,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { createSqsClient } from '@messaging/infrastructure/sqs/sqs-client';
import {
  type QueueUrls,
  ensureQueues,
} from '@messaging/infrastructure/sqs/queue-provisioning';

export const SQS_SETTINGS = {
  endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
  region: process.env.AWS_REGION ?? 'us-east-1',
  accessKeyId: 'test',
  secretAccessKey: 'test',
};

export function createTestSqsClient(): SQSClient {
  return createSqsClient(SQS_SETTINGS);
}

export interface TestQueues {
  readonly urls: QueueUrls;
  readonly environment: Record<string, string>;
  delete(): Promise<void>;
}

export async function createTestQueues(
  client: SQSClient,
  options: { maxReceiveCount?: number; visibilityTimeoutSeconds?: number } = {},
): Promise<TestQueues> {
  const prefix = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const names = {
    commands: `${prefix}-commands.fifo`,
    deadLetter: `${prefix}-commands-dlq.fifo`,
    events: `${prefix}-events.fifo`,
  };
  const urls = await ensureQueues(client, names, options);
  return {
    urls,
    environment: {
      AWS_ENDPOINT_URL: SQS_SETTINGS.endpoint,
      AWS_REGION: SQS_SETTINGS.region,
      SQS_COMMANDS_QUEUE: names.commands,
      SQS_DEAD_LETTER_QUEUE: names.deadLetter,
      SQS_EVENTS_QUEUE: names.events,
    },
    async delete() {
      await Promise.all(
        Object.values(urls).map((QueueUrl) =>
          client.send(new DeleteQueueCommand({ QueueUrl })),
        ),
      );
    },
  };
}

export async function drainQueue(
  client: SQSClient,
  queueUrl: string,
  { idleReceives = 2 } = {},
): Promise<Message[]> {
  const drained: Message[] = [];
  let idle = 0;
  while (idle < idleReceives) {
    const { Messages = [] } = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      }),
    );
    idle = Messages.length === 0 ? idle + 1 : 0;
    for (const message of Messages) {
      drained.push(message);
      await client.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    }
  }
  return drained;
}
