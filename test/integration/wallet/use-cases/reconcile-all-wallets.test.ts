import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { commandFor } from '@test/support/commands';
import { bypassingLedgerGuards } from '@test/support/ledger-states';
import {
  type PersistenceHarness,
  createPersistenceHarness,
} from '@test/support/persistence';
import {
  type Wagering,
  createWagering,
  openWalletWith,
} from '@test/support/wagering';
import { ReconcileAllWallets } from '@wallet/application/use-cases/reconcile-all-wallets';
import type { ReconciliationReport } from '@wallet/application/use-cases/reconcile-wallet';
import { WagerTransactionKind } from '@wallet/domain/transaction/wager-transaction';

let harness: PersistenceHarness;
let wagering: Wagering;

beforeAll(async () => {
  harness = await createPersistenceHarness();
  wagering = createWagering(harness.unitOfWork);
});

afterAll(async () => {
  await harness.close();
});

const reconcileAll = (options: Parameters<ReconcileAllWallets['execute']>[0]) =>
  new ReconcileAllWallets({
    unitOfWork: harness.unitOfWork,
    reconcile: wagering.reconcile,
  }).execute(options);

async function walletIds(): Promise<string[]> {
  const rows: { id: string }[] = await harness.database
    .sql`select id from wallets order by id`;
  return rows.map((row) => row.id);
}

describe('ReconcileAllWallets', () => {
  test('reconciles every wallet in pages and reports the ones that diverge', async () => {
    const opened = [
      await openWalletWith(wagering, '100.00'),
      await openWalletWith(wagering, '0.00'),
      await openWalletWith(wagering, '50.00'),
    ];
    await wagering.submit.execute(
      commandFor(opened[0]!, WagerTransactionKind.Bet, '30.00'),
    );
    const drifted = opened[2]!;
    await bypassingLedgerGuards(
      harness.database.sql,
      (tx) =>
        tx`update wallets set balance_amount = '51.00' where id = ${drifted.id}`,
    );
    const divergent: ReconciliationReport[] = [];

    const summary = await reconcileAll({
      pageSize: 2,
      concurrency: 2,
      onDivergence: (report) => divergent.push(report),
    });

    expect(summary).toEqual({
      checked: 3,
      consistent: 2,
      divergent: 1,
      last: (await walletIds()).at(-1),
    });
    expect(divergent.map((report) => report.walletId)).toEqual([drifted.id]);
  });

  test('stops at a limit and resumes after the last wallet it checked', async () => {
    const ids = await walletIds();

    const first = await reconcileAll({ pageSize: 2, concurrency: 1, limit: 2 });
    const rest = await reconcileAll({
      pageSize: 2,
      concurrency: 1,
      after: first.last,
    });

    expect(first).toMatchObject({ checked: 2, last: ids[1] });
    expect(rest).toMatchObject({ checked: ids.length - 2, last: ids.at(-1) });
  });
});
