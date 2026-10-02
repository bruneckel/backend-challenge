import { afterAll, describe, expect, test } from 'bun:test';
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import { createSqsClient, uniqueSuffix } from './support';

const sqs = createSqsClient();
const suffix = uniqueSuffix();
const createdQueues: string[] = [];

async function createQueuePair(name: string): Promise<{ sourceUrl: string; dlqUrl: string }> {
  const dlq = await sqs.send(
    new CreateQueueCommand({
      QueueName: `spike-${suffix}-${name}-dlq.fifo`,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }),
  );
  const dlqUrl = dlq.QueueUrl!;
  const dlqAttributes = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
  );
  const source = await sqs.send(
    new CreateQueueCommand({
      QueueName: `spike-${suffix}-${name}.fifo`,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: '5',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqAttributes.Attributes?.QueueArn,
          maxReceiveCount: 2,
        }),
      },
    }),
  );
  const sourceUrl = source.QueueUrl!;
  createdQueues.push(sourceUrl, dlqUrl);
  return { sourceUrl, dlqUrl };
}

async function send(
  queueUrl: string,
  body: string,
  groupId: string,
  deduplicationId: string,
  attributes: Record<string, string> = {},
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: deduplicationId,
      MessageAttributes: Object.fromEntries(
        Object.entries(attributes).map(([name, value]) => [
          name,
          { DataType: 'String', StringValue: value },
        ]),
      ),
    }),
  );
}

async function receive(
  queueUrl: string,
  options: { max?: number; waitSeconds?: number; visibilitySeconds?: number } = {},
): Promise<Message[]> {
  const result = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: options.max ?? 1,
      WaitTimeSeconds: options.waitSeconds ?? 1,
      VisibilityTimeout: options.visibilitySeconds,
      MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      MessageAttributeNames: ['All'],
    }),
  );
  return result.Messages ?? [];
}

async function acknowledge(queueUrl: string, message: Message): Promise<void> {
  await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
}

async function release(queueUrl: string, message: Message, visibilitySeconds: number): Promise<void> {
  await sqs.send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: message.ReceiptHandle,
      VisibilityTimeout: visibilitySeconds,
    }),
  );
}


afterAll(async () => {
  await Promise.all(createdQueues.map((queueUrl) => sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }))));
});

describe('MiniStack SQS FIFO behaviour the consumer relies on', () => {
  test('delivers the receive count, the group id and message attributes', async () => {
    const { sourceUrl } = await createQueuePair('attributes');
    await send(sourceUrl, 'attributes', 'wallet-a', `attributes-${suffix}`, { correlationId: 'c-1' });

    const [message] = await receive(sourceUrl);

    expect(message?.Body).toBe('attributes');
    expect(message?.Attributes?.ApproximateReceiveCount).toBe('1');
    expect(message?.Attributes?.MessageGroupId).toBe('wallet-a');
    expect(message?.MessageAttributes?.correlationId?.StringValue).toBe('c-1');
    await acknowledge(sourceUrl, message!);
  });

  test('drops a second send that reuses the deduplication id', async () => {
    const { sourceUrl } = await createQueuePair('dedup');
    await send(sourceUrl, 'same payload', 'wallet-b', `dedup-${suffix}`);
    await send(sourceUrl, 'same payload', 'wallet-b', `dedup-${suffix}`);

    const messages = await receive(sourceUrl, { max: 10 });
    const extra = await receive(sourceUrl, { max: 10 });

    expect(messages.map((message) => message.Body)).toEqual(['same payload']);
    expect(extra).toHaveLength(0);
    await Promise.all(messages.map((message) => acknowledge(sourceUrl, message)));
  });

  test('holds back the rest of a group while one of its messages is in flight', async () => {
    const { sourceUrl } = await createQueuePair('group');
    await send(sourceUrl, 'group first', 'wallet-c', `group-1-${suffix}`);
    await send(sourceUrl, 'group second', 'wallet-c', `group-2-${suffix}`);

    const [inFlight] = await receive(sourceUrl, { max: 1 });
    const whileInFlight = await receive(sourceUrl, { max: 10 });
    await acknowledge(sourceUrl, inFlight!);
    const [next] = await receive(sourceUrl, { max: 1 });

    expect(inFlight?.Body).toBe('group first');
    expect(whileInFlight).toHaveLength(0);
    expect(next?.Body).toBe('group second');
    await acknowledge(sourceUrl, next!);
  });

  test('makes a message visible again at once when its visibility is set to zero', async () => {
    const { sourceUrl } = await createQueuePair('release');
    await send(sourceUrl, 'released', 'wallet-d', `released-${suffix}`);

    const [first] = await receive(sourceUrl);
    await release(sourceUrl, first!, 0);
    const [again] = await receive(sourceUrl);

    expect(again?.Body).toBe('released');
    expect(again?.Attributes?.ApproximateReceiveCount).toBe('2');
    await acknowledge(sourceUrl, again!);
  });

  test('keeps a message hidden while its visibility keeps being extended', async () => {
    const { sourceUrl } = await createQueuePair('heartbeat');
    await send(sourceUrl, 'heartbeat', 'wallet-e', `heartbeat-${suffix}`);

    const [message] = await receive(sourceUrl, { visibilitySeconds: 2 });
    await release(sourceUrl, message!, 8);
    await Bun.sleep(3_000);
    const whileExtended = await receive(sourceUrl, { max: 10 });

    expect(whileExtended).toHaveLength(0);
    await acknowledge(sourceUrl, message!);
  });

  test('moves a message to the dead-letter queue after maxReceiveCount receives', async () => {
    const { sourceUrl, dlqUrl } = await createQueuePair('redrive');
    await send(sourceUrl, 'poison', 'wallet-f', `poison-${suffix}`);

    const [firstReceive] = await receive(sourceUrl);
    await release(sourceUrl, firstReceive!, 0);
    const [secondReceive] = await receive(sourceUrl);
    await release(sourceUrl, secondReceive!, 0);
    const afterLimit = await receive(sourceUrl, { max: 10 });
    const [deadLettered] = await receive(dlqUrl, { waitSeconds: 2 });

    expect(secondReceive?.Attributes?.ApproximateReceiveCount).toBe('2');
    expect(afterLimit).toHaveLength(0);
    expect(deadLettered?.Body).toBe('poison');
    await acknowledge(dlqUrl, deadLettered!);
  });

  test('waits for the long-polling interval on an empty queue', async () => {
    const { sourceUrl } = await createQueuePair('longpoll');
    const startedAt = performance.now();

    const messages = await receive(sourceUrl, { waitSeconds: 2 });
    const elapsedMs = performance.now() - startedAt;

    expect(messages).toHaveLength(0);
    expect(elapsedMs).toBeGreaterThan(1_500);
  });

  test('reports a result for each entry of a batch send', async () => {
    const { sourceUrl } = await createQueuePair('batch');
    const result = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: sourceUrl,
        Entries: [
          { Id: 'one', MessageBody: 'batch one', MessageGroupId: 'wallet-g', MessageDeduplicationId: `batch-1-${suffix}` },
          { Id: 'two', MessageBody: 'batch two', MessageGroupId: 'wallet-g', MessageDeduplicationId: `batch-2-${suffix}` },
        ],
      }),
    );

    expect(result.Successful?.map((entry) => entry.Id).sort()).toEqual(['one', 'two']);
    expect(result.Failed ?? []).toHaveLength(0);
  });

  test('accepts a manual dead-letter send and reports the queue depth', async () => {
    const { dlqUrl } = await createQueuePair('manualdlq');
    await send(dlqUrl, 'manual', 'wallet-h', `manual-${suffix}`, { reason: 'INVALID_MESSAGE' });

    const attributes = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['ApproximateNumberOfMessages'] }),
    );
    const [message] = await receive(dlqUrl, { waitSeconds: 2 });

    expect(Number(attributes.Attributes?.ApproximateNumberOfMessages)).toBeGreaterThanOrEqual(1);
    expect(message?.MessageAttributes?.reason?.StringValue).toBe('INVALID_MESSAGE');
    await acknowledge(dlqUrl, message!);
  });
});
