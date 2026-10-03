import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  type Message,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { DeadLetterRedrive } from '@messaging/infrastructure/sqs/dead-letter-redrive';
import {
  type TestQueues,
  createTestQueues,
  createTestSqsClient,
  drainQueue,
} from '@test/support/sqs';

let sqs: SQSClient;
let queues: TestQueues;
let tool: DeadLetterRedrive;

beforeEach(async () => {
  sqs = createTestSqsClient();
  queues = await createTestQueues(sqs);
  tool = new DeadLetterRedrive(
    sqs,
    { deadLetter: queues.urls.deadLetter, commands: queues.urls.commands },
    { waitSeconds: 0 },
  );
});

afterEach(async () => {
  await queues.delete();
  sqs.destroy();
});

async function deadLetter(groupId: string, reason?: string): Promise<string> {
  const messageId = `msg-${Bun.randomUUIDv7()}`;
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queues.urls.deadLetter,
      MessageBody: JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        data: { walletId: groupId },
      }),
      MessageGroupId: groupId,
      MessageDeduplicationId: Bun.randomUUIDv7(),
      ...(reason === undefined
        ? {}
        : {
            MessageAttributes: {
              reason: { DataType: 'String', StringValue: reason },
              deadLetteredAt: {
                DataType: 'String',
                StringValue: '2026-10-03T12:00:00.000Z',
              },
            },
          }),
    }),
  );
  return messageId;
}

const messageIdOf = (message: Message) =>
  (JSON.parse(message.Body ?? '{}') as { messageId?: string }).messageId;

async function remaining(queueUrl: string): Promise<Message[]> {
  return drainQueue(sqs, queueUrl, { idleReceives: 1 });
}

describe('DeadLetterRedrive', () => {
  test('sends back only the requested reasons and leaves the rest in the dead-letter queue', async () => {
    const retried = await deadLetter('wallet-a', 'RETRIES_EXHAUSTED');
    const conflict = await deadLetter('wallet-b', 'IDEMPOTENCY_KEY_CONFLICT');
    const missing = await deadLetter('wallet-c', 'WALLET_NOT_FOUND');

    const report = await tool.redrive({
      reasons: new Set(['RETRIES_EXHAUSTED']),
    });

    expect(report.dryRun).toBe(false);
    expect(report.redriven.map((item) => item.messageId)).toEqual([retried]);
    expect(report.held.map((item) => item.reason).sort()).toEqual([
      'IDEMPOTENCY_KEY_CONFLICT',
      'WALLET_NOT_FOUND',
    ]);
    const commands = await remaining(queues.urls.commands);
    expect(commands.map(messageIdOf)).toEqual([retried]);
    expect(commands[0]?.Attributes?.MessageGroupId).toBe('wallet-a');
    expect(
      commands[0]?.MessageAttributes?.redrivenFrom?.StringValue,
    ).toBeString();
    expect(
      (await remaining(queues.urls.deadLetter)).map(messageIdOf).sort(),
    ).toEqual([conflict, missing].sort());
  });

  test('keeps the order of a wallet: a message that cannot go back holds the ones behind it', async () => {
    const conflict = await deadLetter('wallet-a', 'IDEMPOTENCY_KEY_CONFLICT');
    const retried = await deadLetter('wallet-a', 'RETRIES_EXHAUSTED');

    const report = await tool.redrive({
      reasons: new Set(['RETRIES_EXHAUSTED']),
    });

    expect(report.redriven).toEqual([]);
    expect(await remaining(queues.urls.commands)).toEqual([]);
    expect((await remaining(queues.urls.deadLetter)).map(messageIdOf)).toEqual([
      conflict,
      retried,
    ]);
  });

  test('sends back the messages of a wallet in their order', async () => {
    const first = await deadLetter('wallet-a', 'RETRIES_EXHAUSTED');
    const second = await deadLetter('wallet-a', 'RETRIES_EXHAUSTED');

    await tool.redrive({ reasons: new Set(['RETRIES_EXHAUSTED']) });

    expect((await remaining(queues.urls.commands)).map(messageIdOf)).toEqual([
      first,
      second,
    ]);
    expect(await remaining(queues.urls.deadLetter)).toEqual([]);
  });

  test('changes nothing in a dry run', async () => {
    const retried = await deadLetter('wallet-a', 'RETRIES_EXHAUSTED');
    const conflict = await deadLetter('wallet-b', 'IDEMPOTENCY_KEY_CONFLICT');

    const report = await tool.redrive({
      reasons: new Set(['RETRIES_EXHAUSTED']),
      dryRun: true,
    });

    expect(report.dryRun).toBe(true);
    expect(report.redriven.map((item) => item.messageId)).toEqual([retried]);
    expect(await remaining(queues.urls.commands)).toEqual([]);
    expect(
      (await remaining(queues.urls.deadLetter)).map(messageIdOf).sort(),
    ).toEqual([retried, conflict].sort());
  });

  test('stops at the limit', async () => {
    for (const wallet of ['wallet-a', 'wallet-b', 'wallet-c']) {
      await deadLetter(wallet, 'RETRIES_EXHAUSTED');
    }

    const report = await tool.redrive({
      reasons: new Set(['RETRIES_EXHAUSTED']),
      limit: 2,
    });

    expect(report.redriven).toHaveLength(2);
    expect(await remaining(queues.urls.commands)).toHaveLength(2);
    expect(await remaining(queues.urls.deadLetter)).toHaveLength(1);
  });

  test('leaves in place a message moved by the queue redrive policy, which carries no reason', async () => {
    const unexplained = await deadLetter('wallet-a');

    const report = await tool.redrive({
      reasons: new Set(['RETRIES_EXHAUSTED']),
    });

    expect(report.held).toEqual([
      expect.objectContaining({ messageId: unexplained, reason: 'UNKNOWN' }),
    ]);
    expect((await remaining(queues.urls.deadLetter)).map(messageIdOf)).toEqual([
      unexplained,
    ]);
  });

  test('lists the dead letters it can see with their reasons and leaves them in place', async () => {
    const retried = await deadLetter('wallet-a', 'RETRIES_EXHAUSTED');
    await deadLetter('wallet-a', 'RETRIES_EXHAUSTED');
    const conflict = await deadLetter('wallet-b', 'IDEMPOTENCY_KEY_CONFLICT');

    const listing = await tool.list();

    expect(listing.approximateTotal).toBe(3);
    expect(
      listing.messages.map((item) => [
        item.messageId,
        item.groupId,
        item.reason,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [retried, 'wallet-a', 'RETRIES_EXHAUSTED'],
        [conflict, 'wallet-b', 'IDEMPOTENCY_KEY_CONFLICT'],
      ]),
    );
    expect(await remaining(queues.urls.deadLetter)).toHaveLength(3);
  });
});

async function runDlq(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(['bun', 'src/cli/dead-letters.ts', ...args], {
    env: { ...process.env, ...queues.environment },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

const linesOf = (stdout: string) =>
  stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe('dlq command', () => {
  test('lists the dead letters as JSON lines', async () => {
    const retried = await deadLetter('wallet-a', 'RETRIES_EXHAUSTED');

    const { exitCode, stdout } = await runDlq(['list']);

    expect(exitCode).toBe(0);
    expect(linesOf(stdout)).toEqual([
      expect.objectContaining({
        msg: 'dead letter',
        messageId: retried,
        walletId: 'wallet-a',
        reason: 'RETRIES_EXHAUSTED',
      }),
      expect.objectContaining({
        msg: 'dead letters listed',
        approximateTotal: 1,
      }),
    ]);
  });

  test('sends back a reason a retry can solve', async () => {
    const retried = await deadLetter('wallet-a', 'RETRIES_EXHAUSTED');

    const { exitCode, stdout } = await runDlq([
      'redrive',
      '--reason',
      'RETRIES_EXHAUSTED',
    ]);

    expect(exitCode).toBe(0);
    expect(linesOf(stdout).at(-1)).toEqual(
      expect.objectContaining({
        msg: 'dead letters sent back',
        dryRun: false,
        redriven: 1,
        held: 0,
      }),
    );
    expect((await remaining(queues.urls.commands)).map(messageIdOf)).toEqual([
      retried,
    ]);
  });

  test('refuses a reason that needs a fix in the message itself', async () => {
    await deadLetter('wallet-a', 'IDEMPOTENCY_KEY_CONFLICT');

    const { exitCode, stderr } = await runDlq([
      'redrive',
      '--reason',
      'IDEMPOTENCY_KEY_CONFLICT',
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('IDEMPOTENCY_KEY_CONFLICT cannot be sent back');
    expect(await remaining(queues.urls.deadLetter)).toHaveLength(1);
  });

  test('explains its usage', async () => {
    const { exitCode, stderr } = await runDlq([]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('usage: bun run dlq');
  });
});
