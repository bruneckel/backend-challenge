import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { SQL } from 'bun';
import { type ApiResponse, requestApi } from '@test/support/api';
import { createMigratedDatabase } from '@test/support/database';
import { walletInvariantViolations } from '@test/support/invariants';
import {
  type LoadWallet,
  type Operation,
  balanceAfter,
  enqueueOperation,
  openWalletOverHttp,
  operationFor,
  storedOutcomes,
  submitOverHttp,
  submitUntilAnswered,
  waitForDrain,
} from '@test/support/load';
import {
  type RunningProcess,
  startApiProcess,
  startWorkerProcess,
} from '@test/support/processes';
import {
  createTestQueues,
  createTestSqsClient,
  drainQueue,
  queueDepth,
} from '@test/support/sqs';

interface Generation {
  apis: RunningProcess[];
  workers: RunningProcess[];
}

interface WalletPlan {
  early: Operation[];
  late: Operation[];
}

let sqs: SQSClient;

beforeAll(() => {
  sqs = createTestSqsClient();
});

afterAll(() => {
  sqs.destroy();
});

async function startGeneration(
  environment: Record<string, string>,
  name: string,
): Promise<Generation> {
  const [apis, workers] = await Promise.all([
    Promise.all(
      [1, 2].map((number) =>
        startApiProcess({
          ...environment,
          INSTANCE_ID: `${name}-api-${number}`,
        }),
      ),
    ),
    Promise.all(
      [1, 2].map((number) =>
        startWorkerProcess({
          ...environment,
          INSTANCE_ID: `${name}-worker-${number}`,
        }),
      ),
    ),
  ]);
  return { apis, workers };
}

const processesOf = (generation: Generation) => [
  ...generation.apis,
  ...generation.workers,
];

async function stopGeneration(
  generation: Generation,
  signal: NodeJS.Signals,
): Promise<void> {
  await Promise.all(
    processesOf(generation).map((running) => running.stop(signal)),
  );
}

function walletPlan(wallet: LoadWallet): WalletPlan {
  const bets = Array.from({ length: 12 }, () =>
    operationFor(wallet, 'BET', '10.00'),
  );
  const wins = Array.from({ length: 6 }, () =>
    operationFor(wallet, 'WIN', '5.00'),
  );
  const refunds = bets
    .slice(0, 3)
    .map((bet) => operationFor(wallet, 'REFUND', '10.00', bet));
  return {
    early: [...refunds, ...bets.slice(3), ...wins.slice(0, 3)],
    late: [...bets.slice(0, 3), ...wins.slice(3)],
  };
}

function interleaved(lists: Operation[][]): Operation[] {
  const longest = Math.max(...lists.map((list) => list.length));
  return Array.from({ length: longest }, (_, index) =>
    lists.flatMap((list) => list.slice(index, index + 1)),
  ).flat();
}

async function pendingReferences(sql: SQL): Promise<number> {
  const [row] = await sql`
    select count(*)::int as count from wager_transactions where status = 'PENDING_REFERENCE'`;
  return row.count;
}

describe('C8 and I10 total restart', () => {
  test.each(['SIGTERM', 'SIGKILL'] as const)(
    'a %s of every process in the middle of the load keeps one effect per operation and the restarted processes drain the rest',
    async (signal) => {
      const database = await createMigratedDatabase();
      const queues = await createTestQueues(sqs);
      const environment = {
        DATABASE_URL: database.url,
        ...queues.environment,
        DB_POOL_SIZE: '5',
        REFERENCE_MAX_ATTEMPTS: '200',
        REFERENCE_BACKOFF_BASE_MS: '100',
        REFERENCE_BACKOFF_MAX_MS: '500',
        REFERENCE_SCHEDULER_POLL_INTERVAL_MS: '50',
        SQS_RECEIVE_WAIT_SECONDS: '1',
        SQS_RECEIVE_TIMEOUT_MS: '3000',
        SQS_VISIBILITY_TIMEOUT_SECONDS: '3',
        SQS_HEARTBEAT_INTERVAL_MS: '1000',
        OUTBOX_POLL_INTERVAL_MS: '50',
      };
      let generation = await startGeneration(environment, 'first');
      const first = generation;
      const messageIds = new Set<string>();
      const unanswered: Operation[] = [];
      const answeredBefore: { operation: Operation; response: ApiResponse }[] =
        [];
      try {
        const wallets = await Promise.all(
          [0, 1, 2].map((index) =>
            openWalletOverHttp(
              generation.apis[index % generation.apis.length]!.url,
              '1000.00',
            ),
          ),
        );
        const plans = wallets.map(walletPlan);
        const early = interleaved(plans.map((plan) => plan.early));
        const late = interleaved(plans.map((plan) => plan.late));
        const operations = [...early, ...late];

        let stopping: Promise<void> | undefined;
        for (const [index, operation] of early.entries()) {
          if (index === Math.floor(early.length / 2)) {
            stopping = stopGeneration(first, signal);
          }
          if (index % 2 === 0) {
            const response = await submitOverHttp(
              first.apis[index % first.apis.length]!.url,
              operation,
            );
            if (response === undefined) {
              unanswered.push(operation);
            } else {
              answeredBefore.push({ operation, response });
            }
          } else {
            messageIds.add(
              await enqueueOperation(sqs, queues.urls.commands, operation, {
                groupId: index % 4 === 1 ? operation.body.walletId : undefined,
              }),
            );
          }
        }
        await stopping;
        expect(await pendingReferences(database.sql)).toBeGreaterThan(0);

        generation = await startGeneration(environment, 'second');
        const urls = generation.apis.map((api) => api.url);
        for (const operation of unanswered) {
          expect([200, 202]).toContain(
            (await submitUntilAnswered(urls, operation)).status,
          );
        }
        for (const [index, operation] of late.entries()) {
          if (index % 2 === 0) {
            expect([200, 202]).toContain(
              (await submitUntilAnswered(urls, operation)).status,
            );
          } else {
            messageIds.add(
              await enqueueOperation(sqs, queues.urls.commands, operation),
            );
          }
        }
        const replayed = answeredBefore.filter(
          ({ response }) => response.status === 200,
        );
        expect(replayed.length).toBeGreaterThan(0);
        for (const { operation, response } of replayed) {
          const replay = await submitUntilAnswered(urls, operation);
          expect(replay.status).toBe(200);
          expect(replay.body.idempotentReplay).toBe(true);
          expect(replay.body.transactionId).toBe(response.body.transactionId);
        }
        await waitForDrain(database.sql, sqs, queues, operations);

        const outcomes = await storedOutcomes(database.sql, operations);
        expect(outcomes.size).toBe(operations.length);
        expect(
          [...outcomes.values()].filter(
            (outcome) => outcome.status !== 'PROCESSED',
          ),
        ).toEqual([]);
        for (const wallet of wallets) {
          const current = await requestApi(
            urls[0]!,
            'GET',
            `/wallets/${wallet.id}`,
          );
          expect(current.body.balance).toEqual({
            amount: balanceAfter(
              '1000.00',
              operations.filter(({ body }) => body.walletId === wallet.id),
            ),
            currency: 'BRL',
          });
          expect(
            await walletInvariantViolations(database.sql, wallet.id),
          ).toEqual([]);
        }
        const [inbox] = await database.sql`
          select count(*)::int as count from inbox_messages`;
        expect(inbox.count).toBe(messageIds.size);
        expect(await queueDepth(sqs, queues.urls.deadLetter)).toBe(0);
        const [outbox] = await database.sql`
          select count(*)::int as count from outbox_messages`;
        const events = await drainQueue(sqs, queues.urls.events);
        const eventIds = events.map(
          (event) => JSON.parse(event.Body!).eventId as string,
        );
        expect(new Set(eventIds).size).toBe(outbox.count);
        if (signal === 'SIGTERM') {
          expect(eventIds).toHaveLength(outbox.count);
          for (const running of processesOf(first)) {
            expect(running.output()).toContain('"msg":"shutdown complete"');
          }
        }
      } finally {
        await stopGeneration(generation, 'SIGTERM');
        await queues.delete();
        await database.drop();
      }
    },
    180_000,
  );
});
