import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  openedWallet,
  settledBet,
  storeOpenedWallet,
} from '@test/support/domain-builders';
import {
  type PersistenceHarness,
  createPersistenceHarness,
  plain,
} from '@test/support/persistence';

let harness: PersistenceHarness;

beforeAll(async () => {
  harness = await createPersistenceHarness();
});

afterAll(async () => {
  await harness.close();
});

describe('MikroOrmLedgerRepository', () => {
  test('appends entries and pages them from the newest wallet version', async () => {
    const opened = openedWallet('100.00');
    await harness.unitOfWork.run((scope) => storeOpenedWallet(scope, opened));
    const second = settledBet(opened.wallet, '10.00');
    const third = settledBet(opened.wallet, '20.00');
    await harness.unitOfWork.run(async ({ transactions, ledger }) => {
      for (const { bet, entry } of [second, third]) {
        await transactions.insert(bet);
        await ledger.append(entry);
      }
    });

    const newest = await harness.unitOfWork.run(({ ledger }) =>
      ledger.page(opened.wallet.id, { limit: 2 }),
    );
    const older = await harness.unitOfWork.run(({ ledger }) =>
      ledger.page(opened.wallet.id, { beforeVersion: 2, limit: 2 }),
    );

    expect(plain(newest.map((entry) => entry.toState()))).toEqual(
      plain([third.entry.toState(), second.entry.toState()]),
    );
    expect(plain(older.map((entry) => entry.toState()))).toEqual(
      plain([opened.openingEntry!.toState()]),
    );
  });

  test('returns an empty page for a wallet opened with a zero balance', async () => {
    const opened = openedWallet('0.00');
    await harness.unitOfWork.run((scope) => storeOpenedWallet(scope, opened));

    expect(
      await harness.unitOfWork.run(({ ledger }) =>
        ledger.page(opened.wallet.id, { limit: 50 }),
      ),
    ).toEqual([]);
  });
});
