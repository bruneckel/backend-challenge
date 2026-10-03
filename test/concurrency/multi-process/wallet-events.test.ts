import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import {
  type TestDatabase,
  createMigratedDatabase,
} from '@test/support/database';
import { OPERATOR, bearerFor } from '@test/support/identity';
import { walletInvariantViolations } from '@test/support/invariants';
import {
  enqueueOperation,
  openWalletOverHttp,
  operationFor,
  runConcurrently,
  submitUntilAnswered,
  waitForDrain,
} from '@test/support/load';
import {
  type RunningProcess,
  startApiProcess,
  startWorkerProcess,
} from '@test/support/processes';
import {
  type TestQueues,
  createTestQueues,
  createTestSqsClient,
} from '@test/support/sqs';
import { type EventStream, openEventStream } from '@test/support/sse';

let database: TestDatabase;
let sqs: SQSClient;
let queues: TestQueues;
let environment: Record<string, string>;
let processes: RunningProcess[] = [];

beforeAll(async () => {
  database = await createMigratedDatabase();
  sqs = createTestSqsClient();
  queues = await createTestQueues(sqs);
  environment = {
    DATABASE_URL: database.url,
    ...queues.environment,
    DB_POOL_SIZE: '5',
    STREAM_SWEEP_INTERVAL_MS: '100',
  };
  processes = await Promise.all([
    startApiProcess({ ...environment, INSTANCE_ID: 'api-1' }),
    startApiProcess({ ...environment, INSTANCE_ID: 'api-2' }),
    startWorkerProcess({
      ...environment,
      INSTANCE_ID: 'worker-1',
      SQS_RECEIVE_WAIT_SECONDS: '1',
      SQS_RECEIVE_TIMEOUT_MS: '3000',
      SQS_VISIBILITY_TIMEOUT_SECONDS: '10',
      SQS_HEARTBEAT_INTERVAL_MS: '1000',
      OUTBOX_POLL_INTERVAL_MS: '50',
    }),
  ]);
}, 90_000);

afterAll(async () => {
  await Promise.all(processes.map((running) => running.stop()));
  await queues.delete();
  sqs.destroy();
  await database.drop();
}, 90_000);

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

async function subscribe(
  url: string,
  walletId: string,
  lastEventId?: string,
): Promise<EventStream> {
  return openEventStream(`${url}/wallets/${walletId}/events`, {
    authorization: await bearerFor({ roles: [OPERATOR] }),
    ...(lastEventId === undefined ? {} : { 'last-event-id': lastEventId }),
  });
}

const versionsOf = (stream: EventStream) =>
  stream.events
    .filter((event) => event.event === 'ledger-entry')
    .map((event) => Number(event.id));

describe('wallet event streams across processes', () => {
  test('deliver to a subscriber of one API process every entry written through another process and through SQS, in order and without gaps', async () => {
    const [watched, writer] = processes;
    const wallet = await openWalletOverHttp(writer!.url, '1000.00');
    const stream = await subscribe(watched!.url, wallet.id);
    await stream.waitFor(1);
    const overHttp = range(1, 20).map((index) =>
      operationFor(wallet, index % 2 === 0 ? 'BET' : 'WIN', '1.00'),
    );
    const overSqs = range(1, 20).map((index) =>
      operationFor(wallet, index % 2 === 0 ? 'BET' : 'WIN', '1.00'),
    );

    await Promise.all([
      runConcurrently(overHttp, 5, async (operation) => {
        await submitUntilAnswered([writer!.url], operation);
      }),
      runConcurrently(overSqs, 5, async (operation) => {
        await enqueueOperation(sqs, queues.urls.commands, operation);
      }),
    ]);
    await waitForDrain(database.sql, sqs, queues, [...overHttp, ...overSqs]);
    await stream.waitFor(41, 20_000);
    stream.close();

    const [stored] = await database.sql`
      select version, balance_amount::text as balance from wallets where id = ${wallet.id}`;
    expect(stored.version).toBe(41);
    expect(versionsOf(stream)).toEqual(range(2, 41));
    expect(stream.events.at(-1)?.data.balanceAfter).toEqual({
      amount: stored.balance,
      currency: 'BRL',
    });
    expect(await walletInvariantViolations(database.sql, wallet.id)).toEqual(
      [],
    );
  });

  test('resume on another API process from Last-Event-ID without gaps or repeats', async () => {
    const [first, second] = processes;
    const wallet = await openWalletOverHttp(first!.url, '1000.00');
    const before = await subscribe(first!.url, wallet.id);
    for (const operation of range(1, 5).map(() =>
      operationFor(wallet, 'BET', '1.00'),
    )) {
      await submitUntilAnswered([second!.url], operation);
    }
    await before.waitFor(6);
    const lastSeen = before.events.at(-1)!.id!;
    before.close();

    for (const operation of range(1, 5).map(() =>
      operationFor(wallet, 'WIN', '1.00'),
    )) {
      await submitUntilAnswered([first!.url], operation);
    }
    const after = await subscribe(second!.url, wallet.id, lastSeen);
    await after.waitFor(5);
    await Bun.sleep(300);
    after.close();

    expect(lastSeen).toBe('6');
    expect([...versionsOf(before), ...versionsOf(after)]).toEqual(range(2, 11));
    expect(await walletInvariantViolations(database.sql, wallet.id)).toEqual(
      [],
    );
  });

  test('end on SIGTERM without holding the process for the clients', async () => {
    const api = await startApiProcess({
      ...environment,
      INSTANCE_ID: 'api-sigterm',
    });
    processes.push(api);
    const wallet = await openWalletOverHttp(api.url, '10.00');
    const stream = await subscribe(api.url, wallet.id);
    await stream.waitFor(1);

    const started = performance.now();
    const code = await api.stop('SIGTERM');

    expect(code).toBe(143);
    expect(performance.now() - started).toBeLessThan(10_000);
    await stream.waitForClose(2000);
    expect(api.output()).toContain('"msg":"shutdown complete"');
  });
});
