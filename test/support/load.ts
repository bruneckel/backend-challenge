import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { SQL } from 'bun';
import { type ApiResponse, requestApi } from './api';
import { waitUntil } from './async';
import { type TestQueues, queueDepth } from './sqs';

export interface LoadWallet {
  id: string;
  playerId: string;
}

export type LoadKind = 'BET' | 'WIN' | 'REFUND' | 'ROLLBACK';

export interface Operation {
  idempotencyKey: string;
  body: {
    providerId: string;
    externalTransactionId: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: LoadKind;
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  };
}

export interface StoredOutcome {
  id: string;
  status: string;
}

const TERMINAL_STATUSES = new Set(['PROCESSED', 'REJECTED', 'FAILED']);
const CREDITS: ReadonlySet<LoadKind> = new Set(['WIN', 'REFUND']);

export function operationFor(
  wallet: LoadWallet,
  kind: LoadKind,
  amount: string,
  reference?: Operation,
): Operation {
  const externalTransactionId = `ext-${Bun.randomUUIDv7()}`;
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    body: {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind,
      money: { amount, currency: 'BRL' },
      ...(reference === undefined
        ? {}
        : {
            referenceExternalTransactionId:
              reference.body.externalTransactionId,
          }),
    },
  };
}

const toCents = (amount: string) => BigInt(amount.replace('.', ''));

export function balanceAfter(
  initial: string,
  operations: readonly Operation[],
): string {
  const kindOf = new Map(
    operations.map((operation) => [
      operation.body.externalTransactionId,
      operation.body.kind,
    ]),
  );
  const cents = operations.reduce((total, { body }) => {
    const amount = toCents(body.money.amount);
    if (body.kind === 'ROLLBACK') {
      const reversed = kindOf.get(body.referenceExternalTransactionId ?? '');
      return reversed === 'BET' ? total + amount : total - amount;
    }
    return CREDITS.has(body.kind) ? total + amount : total - amount;
  }, toCents(initial));
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

export async function openWalletOverHttp(
  baseUrl: string,
  amount: string,
): Promise<LoadWallet> {
  const response = await requestApi(baseUrl, 'POST', '/wallets', {
    body: {
      playerId: Bun.randomUUIDv7(),
      initialBalance: { amount, currency: 'BRL' },
    },
  });
  if (response.status !== 201) {
    throw new Error(`Opening a wallet answered ${response.status}`);
  }
  return { id: response.body.id, playerId: response.body.playerId };
}

export async function enqueueOperation(
  sqs: SQSClient,
  queueUrl: string,
  operation: Operation,
  {
    messageId = `msg-${Bun.randomUUIDv7()}`,
    groupId = Bun.randomUUIDv7(),
  }: { messageId?: string; groupId?: string } = {},
): Promise<string> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: { ...operation.body, idempotencyKey: operation.idempotencyKey },
      }),
      MessageGroupId: groupId,
      MessageDeduplicationId: Bun.randomUUIDv7(),
    }),
  );
  return messageId;
}

export async function submitOverHttp(
  baseUrl: string,
  operation: Operation,
): Promise<ApiResponse | undefined> {
  try {
    const response = await requestApi(
      baseUrl,
      'POST',
      '/wagering/transactions',
      {
        headers: { 'idempotency-key': operation.idempotencyKey },
        body: operation.body,
      },
    );
    return response.status >= 500 ? undefined : response;
  } catch {
    return undefined;
  }
}

export async function submitUntilAnswered(
  baseUrls: readonly string[],
  operation: Operation,
  { attempts = 40, delayMs = 250 } = {},
): Promise<ApiResponse> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await submitOverHttp(
      baseUrls[attempt % baseUrls.length]!,
      operation,
    );
    if (response !== undefined) {
      return response;
    }
    await Bun.sleep(delayMs);
  }
  throw new Error(`No answer for ${operation.idempotencyKey}`);
}

export async function runConcurrently<T>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        await work(items[index]!, index);
      }
    }),
  );
}

export function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[other]] = [copy[other]!, copy[index]!];
  }
  return copy;
}

export async function storedOutcomes(
  sql: SQL,
  operations: readonly Operation[],
): Promise<Map<string, StoredOutcome>> {
  const keys = operations.map((operation) => operation.idempotencyKey);
  const rows = await sql`
    select idempotency_key, id, status from wager_transactions
    where idempotency_key in ${sql(keys)}`;
  return new Map(
    rows.map((row: { idempotency_key: string; id: string; status: string }) => [
      row.idempotency_key,
      { id: row.id, status: row.status },
    ]),
  );
}

export async function pendingOutboxEvents(sql: SQL): Promise<number> {
  const [row] = await sql`
    select count(*)::int as count from outbox_messages where published_at is null`;
  return row.count;
}

export async function waitForDrain(
  sql: SQL,
  sqs: SQSClient,
  queues: TestQueues,
  operations: readonly Operation[],
  timeoutMs = 90_000,
): Promise<void> {
  await waitUntil(
    async () => {
      const outcomes = await storedOutcomes(sql, operations);
      const settled = [...outcomes.values()].filter((outcome) =>
        TERMINAL_STATUSES.has(outcome.status),
      );
      return (
        settled.length === operations.length &&
        (await queueDepth(sqs, queues.urls.commands)) === 0 &&
        (await pendingOutboxEvents(sql)) === 0
      );
    },
    { timeoutMs, intervalMs: 250, description: 'the load to drain' },
  );
}
