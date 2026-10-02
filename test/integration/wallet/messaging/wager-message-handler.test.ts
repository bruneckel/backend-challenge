import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  type Message,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { MessageBatchConsumer } from '@messaging/infrastructure/sqs/message-batch-consumer';
import { CanonicalJsonFingerprinter } from '@platform/crypto/canonical-json-fingerprinter';
import { MikroOrmUnitOfWork } from '@platform/database/mikro-orm-unit-of-work';
import { ExponentialBackoff } from '@shared/domain/exponential-backoff';
import { walletInvariantViolations } from '@test/support/invariants';
import {
  type PersistenceHarness,
  createPersistenceHarness,
} from '@test/support/persistence';
import {
  type TestQueues,
  createTestQueues,
  createTestSqsClient,
  drainQueue,
} from '@test/support/sqs';
import {
  type Wagering,
  createWagering,
  openWalletWith,
} from '@test/support/wagering';
import type { WalletView } from '@wallet/application/views';
import { createWageringScope } from '@wallet/infrastructure/persistence/wagering-scope';
import { WagerMessageHandler } from '@wallet/infrastructure/messaging/wager-message-handler';

let harness: PersistenceHarness;
let wagering: Wagering;
let sqs: SQSClient;
let queues: TestQueues;

beforeEach(async () => {
  harness = await createPersistenceHarness();
  wagering = createWagering(harness.unitOfWork);
  sqs = createTestSqsClient();
  queues = await createTestQueues(sqs);
});

afterEach(async () => {
  await queues.delete();
  sqs.destroy();
  await harness.close();
});

function consumer(
  options: { maxAttempts?: number; submit?: Wagering['submit'] } = {},
): MessageBatchConsumer {
  const handler = new WagerMessageHandler({
    submit: options.submit ?? wagering.submit,
    fingerprinter: new CanonicalJsonFingerprinter(),
    clock: wagering.clock,
    consumerName: 'wager-transactions-consumer',
    maxAttempts: options.maxAttempts ?? 8,
    retryBackoff: ExponentialBackoff.create({
      baseMs: 1000,
      maxMs: 1000,
      random: () => 1,
    }),
  });
  return new MessageBatchConsumer({
    client: sqs,
    queueUrl: queues.urls.commands,
    deadLetterQueueUrl: queues.urls.deadLetter,
    handler: handler.handle,
    instanceId: 'worker-test',
    batchSize: 10,
    waitTimeSeconds: 1,
    visibilityTimeoutSeconds: 10,
    heartbeatIntervalMs: 1000,
    maxConcurrentGroups: 5,
  });
}

interface Envelope {
  messageId: string;
  type: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

function requestFor(
  wallet: WalletView,
  kind = 'BET',
  amount = '25.00',
  messageId = `msg-${Bun.randomUUIDv7()}`,
): Envelope {
  const externalTransactionId = `ext-${Bun.randomUUIDv7()}`;
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: '2026-10-02T12:00:00.000Z',
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind,
      money: { amount, currency: 'BRL' },
    },
  };
}

async function send(body: string | Envelope, groupId: string): Promise<string> {
  const { MessageId } = await sqs.send(
    new SendMessageCommand({
      QueueUrl: queues.urls.commands,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: Bun.randomUUIDv7(),
    }),
  );
  return MessageId!;
}

async function consumeUntilEmpty(target: MessageBatchConsumer): Promise<void> {
  while ((await target.consumeOnce(new AbortController().signal)) > 0) {
    await Bun.sleep(1);
  }
}

async function balanceOf(walletId: string): Promise<string> {
  return (await wagering.queries.getWallet(walletId)).balance.amount;
}

const reasonOf = (message: Message | undefined) =>
  message?.MessageAttributes?.reason?.StringValue;

describe('wager command consumer (I5)', () => {
  test('applies a message and acknowledges it after the commit', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    const request = requestFor(wallet);
    await send(request, wallet.id);

    await consumeUntilEmpty(consumer());

    expect(await balanceOf(wallet.id)).toBe('75.00');
    const [transaction] = await harness.database.sql`
      select id, correlation_id from wager_transactions where idempotency_key = ${request.data.idempotencyKey}`;
    expect(transaction.correlation_id).toBe(request.messageId);
    const [inbox] = await harness.database.sql`
      select transaction_id, processed_at from inbox_messages where message_id = ${request.messageId}`;
    expect(inbox.transaction_id).toBe(transaction.id);
    expect(inbox.processed_at).not.toBeNull();
    expect(
      await drainQueue(sqs, queues.urls.commands, { idleReceives: 1 }),
    ).toEqual([]);
    expect(
      await walletInvariantViolations(harness.database.sql, wallet.id),
    ).toEqual([]);
  });

  test('applies a message delivered twice only once', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    const request = requestFor(wallet);
    await send(request, wallet.id);
    await send(request, wallet.id);

    await consumeUntilEmpty(consumer());

    expect(await balanceOf(wallet.id)).toBe('75.00');
    const inbox = await harness.database
      .sql`select 1 from inbox_messages where message_id = ${request.messageId}`;
    expect(inbox).toHaveLength(1);
    expect(
      await walletInvariantViolations(harness.database.sql, wallet.id),
    ).toEqual([]);
  });

  test('records another message id carrying an operation already applied as a replay', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    const first = requestFor(wallet);
    const second = { ...first, messageId: `msg-${Bun.randomUUIDv7()}` };
    await send(first, wallet.id);
    await send(second, wallet.id);

    await consumeUntilEmpty(consumer());

    expect(await balanceOf(wallet.id)).toBe('75.00');
    const inbox = await harness.database.sql`
      select distinct transaction_id from inbox_messages where message_id in (${first.messageId}, ${second.messageId})`;
    expect(inbox).toHaveLength(1);
  });

  test('dead-letters a message id reused with another payload as MESSAGE_ID_CONFLICT', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    const first = requestFor(wallet, 'BET', '25.00', 'msg-shared');
    const reused = requestFor(wallet, 'BET', '30.00', 'msg-shared');
    await send(first, wallet.id);
    const reusedSqsId = await send(reused, wallet.id);

    await consumeUntilEmpty(consumer());

    expect(await balanceOf(wallet.id)).toBe('75.00');
    const [deadLetter] = await drainQueue(sqs, queues.urls.deadLetter);
    expect(reasonOf(deadLetter)).toBe('MESSAGE_ID_CONFLICT');
    expect(deadLetter?.Attributes?.MessageDeduplicationId).toBe(reusedSqsId);
    expect(deadLetter?.MessageAttributes?.originalMessageId?.StringValue).toBe(
      'msg-shared',
    );
  });
});

describe('wager command consumer (I6)', () => {
  test.each([
    ['a body that is not JSON', () => '{"messageId":'],
    [
      'an unexpected message type',
      (wallet: WalletView) =>
        JSON.stringify({ ...requestFor(wallet), type: 'SomethingElse' }),
    ],
    [
      'a request without an idempotency key',
      (wallet: WalletView) => {
        const request = requestFor(wallet);
        const data: Record<string, unknown> = { ...request.data };
        delete data.idempotencyKey;
        return JSON.stringify({ ...request, data });
      },
    ],
    [
      'an OPENING',
      (wallet: WalletView) => JSON.stringify(requestFor(wallet, 'OPENING')),
    ],
    [
      'a REFUND without a reference',
      (wallet: WalletView) => JSON.stringify(requestFor(wallet, 'REFUND')),
    ],
  ])('dead-letters %s at once as INVALID_MESSAGE', async (_, bodyFor) => {
    const wallet = await openWalletWith(wagering, '100.00');
    await send(bodyFor(wallet), wallet.id);

    await consumeUntilEmpty(consumer());

    const [deadLetter] = await drainQueue(sqs, queues.urls.deadLetter);
    expect(reasonOf(deadLetter)).toBe('INVALID_MESSAGE');
    expect(deadLetter?.MessageAttributes?.receiveCount?.StringValue).toBe('1');
    expect(await balanceOf(wallet.id)).toBe('100.00');
  });

  test('dead-letters a message for an unknown wallet as WALLET_NOT_FOUND', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    await send(requestFor({ ...wallet, id: Bun.randomUUIDv7() }), wallet.id);

    await consumeUntilEmpty(consumer());

    expect(reasonOf((await drainQueue(sqs, queues.urls.deadLetter))[0])).toBe(
      'WALLET_NOT_FOUND',
    );
  });

  test('dead-letters an idempotency key reused with another payload as IDEMPOTENCY_KEY_CONFLICT', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    const first = requestFor(wallet);
    const conflicting = requestFor(wallet, 'BET', '26.00');
    conflicting.data.idempotencyKey = first.data.idempotencyKey;
    await send(first, wallet.id);
    await send(conflicting, wallet.id);

    await consumeUntilEmpty(consumer());

    expect(reasonOf((await drainQueue(sqs, queues.urls.deadLetter))[0])).toBe(
      'IDEMPOTENCY_KEY_CONFLICT',
    );
    expect(await balanceOf(wallet.id)).toBe('75.00');
  });

  test('acknowledges a business rejection without dead-lettering it', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    const request = requestFor(wallet, 'BET', '500.00');
    await send(request, wallet.id);

    await consumeUntilEmpty(consumer());

    const [transaction] = await harness.database.sql`
      select status, failure_code from wager_transactions where idempotency_key = ${request.data.idempotencyKey}`;
    expect(transaction).toEqual({
      status: 'REJECTED',
      failure_code: 'INSUFFICIENT_FUNDS',
    });
    expect(
      await drainQueue(sqs, queues.urls.commands, { idleReceives: 1 }),
    ).toEqual([]);
    expect(
      await drainQueue(sqs, queues.urls.deadLetter, { idleReceives: 1 }),
    ).toEqual([]);
  });

  test('retries a transient failure with backoff and dead-letters it once the attempts run out', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    const impatient = createWagering(
      new MikroOrmUnitOfWork(harness.orm, createWageringScope, {
        lockTimeoutMs: 200,
      }),
    );
    impatient.clock.set(wagering.clock.now());
    const target = consumer({ maxAttempts: 2, submit: impatient.submit });
    const request = requestFor(wallet);
    await send(request, wallet.id);
    const holder = await harness.database.sql.reserve();
    await holder`begin`;
    await holder`select id from wallets where id = ${wallet.id} for update`;

    try {
      await target.consumeOnce(new AbortController().signal);
      const afterFirstAttempt = await harness.database.sql`
        select 1 from wager_transactions where idempotency_key = ${request.data.idempotencyKey}`;
      await Bun.sleep(1500);
      await target.consumeOnce(new AbortController().signal);

      expect(afterFirstAttempt).toHaveLength(0);
    } finally {
      await holder`rollback`;
      holder.release();
    }

    const [deadLetter] = await drainQueue(sqs, queues.urls.deadLetter);
    expect(reasonOf(deadLetter)).toBe('RETRIES_EXHAUSTED');
    expect(deadLetter?.MessageAttributes?.receiveCount?.StringValue).toBe('2');
    expect(await balanceOf(wallet.id)).toBe('100.00');
  });
});
