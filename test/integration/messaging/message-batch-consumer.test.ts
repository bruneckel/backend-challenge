import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import {
  type ConsumedMessage,
  ConsumerPausedError,
  type Disposition,
  type MessageBatchConsumerOptions,
  MessageBatchConsumer,
} from '@messaging/infrastructure/sqs/message-batch-consumer';
import { rejectionOf } from '@test/support/async';
import {
  type TestQueues,
  createTestQueues,
  createTestSqsClient,
  drainQueue,
} from '@test/support/sqs';

let sqs: SQSClient;
let queues: TestQueues;

beforeEach(async () => {
  sqs = createTestSqsClient();
  queues = await createTestQueues(sqs);
});

afterEach(async () => {
  await queues.delete();
  sqs.destroy();
});

async function send(body: string, groupId: string): Promise<string> {
  const { MessageId } = await sqs.send(
    new SendMessageCommand({
      QueueUrl: queues.urls.commands,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: Bun.randomUUIDv7(),
    }),
  );
  return MessageId!;
}

function consumerWith(
  handler: (message: ConsumedMessage) => Promise<Disposition>,
  overrides: Partial<MessageBatchConsumerOptions> = {},
): MessageBatchConsumer {
  return new MessageBatchConsumer({
    client: sqs,
    queueUrl: queues.urls.commands,
    deadLetterQueueUrl: queues.urls.deadLetter,
    handler,
    instanceId: 'consumer-test',
    batchSize: 10,
    waitTimeSeconds: 1,
    visibilityTimeoutSeconds: 10,
    heartbeatIntervalMs: 1000,
    maxConcurrentGroups: 5,
    deadLetterRetryDelaySeconds: 1,
    ...overrides,
  });
}

const acknowledge = async (): Promise<Disposition> => ({
  action: 'acknowledge',
});

async function visibleMessages(): Promise<number> {
  const { Messages = [] } = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queues.urls.commands,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      VisibilityTimeout: 0,
    }),
  );
  return Messages.length;
}

describe('MessageBatchConsumer', () => {
  test('acknowledges handled messages so they are not delivered again', async () => {
    await send('a', 'group-a');
    await send('b', 'group-b');
    await send('c', 'group-c');

    const received = await consumerWith(acknowledge).consumeOnce(
      new AbortController().signal,
    );

    expect(received).toBe(3);
    expect(
      await drainQueue(sqs, queues.urls.commands, { idleReceives: 1 }),
    ).toEqual([]);
  });

  test('handles the messages of a group in order while different groups run in parallel', async () => {
    for (const body of ['a1', 'a2', 'a3']) {
      await send(body, 'group-a');
    }
    for (const body of ['b1', 'b2']) {
      await send(body, 'group-b');
    }
    const events: string[] = [];
    const handler = async (message: ConsumedMessage): Promise<Disposition> => {
      events.push(`start ${message.body}`);
      await Bun.sleep(100);
      events.push(`end ${message.body}`);
      return { action: 'acknowledge' };
    };

    await consumerWith(handler).consumeOnce(new AbortController().signal);

    const order = (prefix: string) =>
      events.filter(
        (event) => event.startsWith('end ') && event.includes(prefix),
      );
    expect(order(' a')).toEqual(['end a1', 'end a2', 'end a3']);
    expect(order(' b')).toEqual(['end b1', 'end b2']);
    expect(events.indexOf('start b1')).toBeLessThan(events.indexOf('end a1'));
  });

  test('retries a message later and holds back the rest of its group until it is done', async () => {
    await send('a1', 'group-a');
    await send('a2', 'group-a');
    await send('b1', 'group-b');
    const handled: string[] = [];
    const handler = async (message: ConsumedMessage): Promise<Disposition> => {
      handled.push(`${message.body}#${message.receiveCount}`);
      return message.body === 'a1' && message.receiveCount === 1
        ? { action: 'retry', delaySeconds: 2 }
        : { action: 'acknowledge' };
    };
    const consumer = consumerWith(handler);

    await consumer.consumeOnce(new AbortController().signal);
    const heldBack = await consumer.consumeOnce(new AbortController().signal);
    await Bun.sleep(2500);
    await consumer.consumeOnce(new AbortController().signal);

    expect(heldBack).toBe(0);
    expect(handled).toEqual(['a1#1', 'b1#1', 'a1#2', 'a2#2']);
  });

  test('moves a message to the dead-letter queue with its group and SQS id, then removes it from the source', async () => {
    const sqsMessageId = await send('{"broken":', 'group-a');

    await consumerWith(async () => ({
      action: 'dead_letter',
      reason: 'INVALID_MESSAGE',
      originalMessageId: 'msg-1',
    })).consumeOnce(new AbortController().signal);

    const [deadLetter] = await drainQueue(sqs, queues.urls.deadLetter);
    expect(deadLetter?.Body).toBe('{"broken":');
    expect(deadLetter?.Attributes?.MessageGroupId).toBe('group-a');
    expect(deadLetter?.Attributes?.MessageDeduplicationId).toBe(sqsMessageId);
    expect(deadLetter?.MessageAttributes?.reason?.StringValue).toBe(
      'INVALID_MESSAGE',
    );
    expect(deadLetter?.MessageAttributes?.sqsMessageId?.StringValue).toBe(
      sqsMessageId,
    );
    expect(deadLetter?.MessageAttributes?.originalMessageId?.StringValue).toBe(
      'msg-1',
    );
    expect(deadLetter?.MessageAttributes?.receiveCount?.StringValue).toBe('1');
    expect(deadLetter?.MessageAttributes?.instanceId?.StringValue).toBe(
      'consumer-test',
    );
    expect(
      await drainQueue(sqs, queues.urls.commands, { idleReceives: 1 }),
    ).toEqual([]);
  });

  test('keeps the message in the source when the dead-letter queue refuses it', async () => {
    await send('poison', 'group-a');
    const missingDeadLetterQueue = `${queues.urls.deadLetter.replace(/[^/]+$/, '')}missing-${Bun.randomUUIDv7()}.fifo`;

    await consumerWith(
      async () => ({ action: 'dead_letter', reason: 'INVALID_MESSAGE' }),
      {
        deadLetterQueueUrl: missingDeadLetterQueue,
      },
    ).consumeOnce(new AbortController().signal);
    await Bun.sleep(1500);

    const remaining = await drainQueue(sqs, queues.urls.commands, {
      idleReceives: 1,
    });
    expect(remaining.map((message) => message.Body)).toEqual(['poison']);
  });

  test('keeps extending the visibility while a slow message is being handled', async () => {
    await send('slow', 'group-a');
    let otherReceived = 0;
    const slow = consumerWith(
      async () => {
        await Bun.sleep(3500);
        return { action: 'acknowledge' };
      },
      { visibilityTimeoutSeconds: 2, heartbeatIntervalMs: 500 },
    );
    const other = consumerWith(
      async () => {
        otherReceived += 1;
        return { action: 'acknowledge' };
      },
      { visibilityTimeoutSeconds: 2 },
    );

    const slowRun = slow.consumeOnce(new AbortController().signal);
    await Bun.sleep(300);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      await other.consumeOnce(new AbortController().signal);
    }
    await slowRun;

    expect(otherReceived).toBe(0);
    expect(
      await drainQueue(sqs, queues.urls.commands, { idleReceives: 1 }),
    ).toEqual([]);
  });

  test('pauses after a lost database connection and gives back what it did not start', async () => {
    await send('a1', 'group-a');
    await send('b1', 'group-b');
    const handled: string[] = [];
    const consumer = consumerWith(
      async (message) => {
        handled.push(message.body);
        return { action: 'retry', delaySeconds: 30, pauseConsumer: true };
      },
      { maxConcurrentGroups: 1 },
    );

    const failure = await rejectionOf(
      consumer.consumeOnce(new AbortController().signal),
    );

    expect(failure).toBeInstanceOf(ConsumerPausedError);
    expect(handled).toEqual(['a1']);
    expect(await visibleMessages()).toBe(1);
  });

  test('finishes the message in progress and gives back the others when stopping', async () => {
    await send('a1', 'group-a');
    await send('b1', 'group-b');
    await send('c1', 'group-c');
    const controller = new AbortController();
    const handled: string[] = [];
    const consumer = consumerWith(
      async (message) => {
        handled.push(message.body);
        controller.abort();
        await Bun.sleep(200);
        return { action: 'acknowledge' };
      },
      { maxConcurrentGroups: 1 },
    );

    await consumer.consumeOnce(controller.signal);

    expect(handled).toEqual(['a1']);
    expect(await visibleMessages()).toBe(2);
  });

  test('returns quickly when stopped during a long poll', async () => {
    const controller = new AbortController();
    const consumer = consumerWith(acknowledge, { waitTimeSeconds: 10 });

    const started = Date.now();
    const run = consumer.consumeOnce(controller.signal);
    await Bun.sleep(100);
    controller.abort();

    expect(await run).toBe(0);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
