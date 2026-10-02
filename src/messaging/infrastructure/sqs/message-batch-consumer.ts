import {
  ChangeMessageVisibilityBatchCommand,
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  type SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import type { QueueUrlSource } from './sqs-event-publisher';

export interface ConsumedMessage {
  sqsMessageId: string;
  receiptHandle: string;
  body: string;
  groupId: string;
  receiveCount: number;
}

export type Disposition =
  | { action: 'acknowledge' }
  | {
      action: 'retry';
      delaySeconds: number;
      reason?: string;
      pauseConsumer?: boolean;
    }
  | { action: 'dead_letter'; reason: string; originalMessageId?: string };

export type MessageHandler = (message: ConsumedMessage) => Promise<Disposition>;

export type ConsumerEvent =
  | { type: 'handled'; message: ConsumedMessage; disposition: Disposition }
  | { type: 'handler_failed'; message: ConsumedMessage; error: unknown }
  | { type: 'dead_lettered'; message: ConsumedMessage; reason: string }
  | { type: 'dead_letter_failed'; message: ConsumedMessage; error: unknown }
  | { type: 'queue_call_failed'; operation: string; error: unknown };

export interface MessageBatchConsumerOptions {
  client: SQSClient;
  queueUrl: QueueUrlSource;
  deadLetterQueueUrl: QueueUrlSource;
  handler: MessageHandler;
  instanceId: string;
  batchSize: number;
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
  heartbeatIntervalMs: number;
  maxConcurrentGroups: number;
  deadLetterRetryDelaySeconds?: number;
  onEvent?: (event: ConsumerEvent) => void;
}

export class ConsumerPausedError extends Error {
  constructor() {
    super('The consumer paused because a dependency is unavailable');
    this.name = 'ConsumerPausedError';
  }
}

const DEFAULT_DEAD_LETTER_RETRY_DELAY_SECONDS = 30;
const UNHANDLED_RETRY_DELAY_SECONDS = 5;

type Outcome = 'settled' | 'holds_group';

export class MessageBatchConsumer {
  constructor(private readonly options: MessageBatchConsumerOptions) {}

  async consumeOnce(signal: AbortSignal): Promise<number> {
    const messages = await this.receive(signal);
    if (messages.length === 0) {
      return 0;
    }
    const retained = new Set(messages);
    const heartbeat = setInterval(
      () => void this.extendVisibility([...retained]),
      this.options.heartbeatIntervalMs,
    );
    let paused = false;
    try {
      await forEachWithConcurrency(
        groupsOf(messages),
        this.options.maxConcurrentGroups,
        async (group) => {
          for (const [index, message] of group.entries()) {
            if (signal.aborted || paused) {
              await this.release(group.slice(index), retained);
              return;
            }
            const disposition = await this.handle(message);
            const outcome = await this.settle(message, disposition);
            retained.delete(message);
            if (
              disposition.action === 'retry' &&
              disposition.pauseConsumer === true
            ) {
              paused = true;
            }
            if (outcome === 'holds_group') {
              await this.release(group.slice(index + 1), retained);
              return;
            }
          }
        },
      );
    } finally {
      clearInterval(heartbeat);
    }
    if (paused) {
      throw new ConsumerPausedError();
    }
    return messages.length;
  }

  private async receive(signal: AbortSignal): Promise<ConsumedMessage[]> {
    if (signal.aborted) {
      return [];
    }
    try {
      const { Messages = [] } = await this.options.client.send(
        new ReceiveMessageCommand({
          QueueUrl: await this.url(this.options.queueUrl),
          MaxNumberOfMessages: this.options.batchSize,
          WaitTimeSeconds: this.options.waitTimeSeconds,
          VisibilityTimeout: this.options.visibilityTimeoutSeconds,
          MessageSystemAttributeNames: [
            'ApproximateReceiveCount',
            'MessageGroupId',
          ],
        }),
        { abortSignal: signal },
      );
      return Messages.flatMap(toConsumedMessage);
    } catch (error) {
      if (signal.aborted) {
        return [];
      }
      throw error;
    }
  }

  private async handle(message: ConsumedMessage): Promise<Disposition> {
    try {
      const disposition = await this.options.handler(message);
      this.options.onEvent?.({ type: 'handled', message, disposition });
      return disposition;
    } catch (error) {
      this.options.onEvent?.({ type: 'handler_failed', message, error });
      return { action: 'retry', delaySeconds: UNHANDLED_RETRY_DELAY_SECONDS };
    }
  }

  private async settle(
    message: ConsumedMessage,
    disposition: Disposition,
  ): Promise<Outcome> {
    switch (disposition.action) {
      case 'acknowledge':
        await this.delete(message);
        return 'settled';
      case 'retry':
        await this.changeVisibility(message, disposition.delaySeconds);
        return 'holds_group';
      case 'dead_letter':
        return this.deadLetter(
          message,
          disposition.reason,
          disposition.originalMessageId,
        );
    }
  }

  private async deadLetter(
    message: ConsumedMessage,
    reason: string,
    originalMessageId: string | undefined,
  ): Promise<Outcome> {
    try {
      await this.options.client.send(
        new SendMessageCommand({
          QueueUrl: await this.url(this.options.deadLetterQueueUrl),
          MessageBody: message.body,
          MessageGroupId: message.groupId,
          MessageDeduplicationId: message.sqsMessageId,
          MessageAttributes: attributes({
            reason,
            sqsMessageId: message.sqsMessageId,
            receiveCount: String(message.receiveCount),
            instanceId: this.options.instanceId,
            deadLetteredAt: new Date().toISOString(),
            ...(originalMessageId === undefined ? {} : { originalMessageId }),
          }),
        }),
      );
    } catch (error) {
      this.options.onEvent?.({ type: 'dead_letter_failed', message, error });
      await this.changeVisibility(
        message,
        this.options.deadLetterRetryDelaySeconds ??
          DEFAULT_DEAD_LETTER_RETRY_DELAY_SECONDS,
      );
      return 'holds_group';
    }
    this.options.onEvent?.({ type: 'dead_lettered', message, reason });
    await this.delete(message);
    return 'settled';
  }

  private async delete(message: ConsumedMessage): Promise<void> {
    await this.attempt('DeleteMessage', async () =>
      this.options.client.send(
        new DeleteMessageCommand({
          QueueUrl: await this.url(this.options.queueUrl),
          ReceiptHandle: message.receiptHandle,
        }),
      ),
    );
  }

  private async changeVisibility(
    message: ConsumedMessage,
    seconds: number,
  ): Promise<void> {
    await this.attempt('ChangeMessageVisibility', async () =>
      this.options.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: await this.url(this.options.queueUrl),
          ReceiptHandle: message.receiptHandle,
          VisibilityTimeout: Math.max(0, Math.min(43_200, Math.ceil(seconds))),
        }),
      ),
    );
  }

  private async release(
    messages: ConsumedMessage[],
    retained: Set<ConsumedMessage>,
  ): Promise<void> {
    for (const message of messages) {
      retained.delete(message);
    }
    await this.changeVisibilityOf(messages, 0, 'ReleaseMessages');
  }

  private async extendVisibility(messages: ConsumedMessage[]): Promise<void> {
    await this.changeVisibilityOf(
      messages,
      this.options.visibilityTimeoutSeconds,
      'ExtendVisibility',
    );
  }

  private async changeVisibilityOf(
    messages: ConsumedMessage[],
    seconds: number,
    operation: string,
  ): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    await this.attempt(operation, async () =>
      this.options.client.send(
        new ChangeMessageVisibilityBatchCommand({
          QueueUrl: await this.url(this.options.queueUrl),
          Entries: messages.map((message, index) => ({
            Id: String(index),
            ReceiptHandle: message.receiptHandle,
            VisibilityTimeout: seconds,
          })),
        }),
      ),
    );
  }

  private async attempt(
    operation: string,
    call: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await call();
    } catch (error) {
      this.options.onEvent?.({ type: 'queue_call_failed', operation, error });
    }
  }

  private url(source: QueueUrlSource): Promise<string> {
    return typeof source === 'string' ? Promise.resolve(source) : source();
  }
}

function toConsumedMessage(message: Message): ConsumedMessage[] {
  if (message.MessageId === undefined || message.ReceiptHandle === undefined) {
    return [];
  }
  return [
    {
      sqsMessageId: message.MessageId,
      receiptHandle: message.ReceiptHandle,
      body: message.Body ?? '',
      groupId: message.Attributes?.MessageGroupId ?? '',
      receiveCount: Number.parseInt(
        message.Attributes?.ApproximateReceiveCount ?? '1',
        10,
      ),
    },
  ];
}

function groupsOf(messages: ConsumedMessage[]): ConsumedMessage[][] {
  const groups = new Map<string, ConsumedMessage[]>();
  for (const message of messages) {
    const group = groups.get(message.groupId) ?? [];
    group.push(message);
    groups.set(message.groupId, group);
  }
  return [...groups.values()];
}

async function forEachWithConcurrency<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const item = items[next];
        next += 1;
        if (item !== undefined) {
          await work(item);
        }
      }
    },
  );
  await Promise.all(runners);
}

function attributes(values: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      { DataType: 'String', StringValue: value },
    ]),
  );
}
