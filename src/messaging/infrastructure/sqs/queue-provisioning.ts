import { CreateQueueCommand, GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';

export interface QueueNames {
  commands: string;
  deadLetter: string;
  events: string;
}

export type QueueUrls = QueueNames;

export interface QueueProvisioningOptions {
  maxReceiveCount?: number;
  visibilityTimeoutSeconds?: number;
}

const FOURTEEN_DAYS_SECONDS = 14 * 24 * 60 * 60;

export async function ensureQueues(
  client: SQSClient,
  names: QueueNames,
  options: QueueProvisioningOptions = {},
): Promise<QueueUrls> {
  const deadLetter = await createFifoQueue(client, names.deadLetter, {
    MessageRetentionPeriod: String(FOURTEEN_DAYS_SECONDS),
  });
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: deadLetter, AttributeNames: ['QueueArn'] }),
  );
  const commands = await createFifoQueue(client, names.commands, {
    VisibilityTimeout: String(options.visibilityTimeoutSeconds ?? 30),
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: Attributes?.QueueArn,
      maxReceiveCount: options.maxReceiveCount ?? 10,
    }),
  });
  const events = await createFifoQueue(client, names.events, {});
  return { commands, deadLetter, events };
}

export async function queueUrlOf(client: SQSClient, queueName: string): Promise<string> {
  const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: queueName }));
  if (QueueUrl === undefined) {
    throw new Error(`Queue ${queueName} has no URL`);
  }
  return QueueUrl;
}

export function lazyQueueUrl(client: SQSClient, queueName: string): () => Promise<string> {
  let resolved: Promise<string> | undefined;
  return () => {
    resolved ??= queueUrlOf(client, queueName).catch((error: unknown) => {
      resolved = undefined;
      throw error;
    });
    return resolved;
  };
}

async function createFifoQueue(client: SQSClient, name: string, attributes: Record<string, string>): Promise<string> {
  const { QueueUrl } = await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', ...attributes },
    }),
  );
  if (QueueUrl === undefined) {
    throw new Error(`Queue ${name} was created without a URL`);
  }
  return QueueUrl;
}
