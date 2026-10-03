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

  test('reads the entries after a wallet version, oldest first', async () => {
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
    const after = (version: number, limit: number) =>
      harness.unitOfWork.run(({ ledger }) =>
        ledger.after(opened.wallet.id, version, limit),
      );

    const all = await after(0, 10);
    const next = await after(1, 1);
    const none = await after(3, 10);

    expect(plain(all.map((entry) => entry.toState()))).toEqual(
      plain([
        opened.openingEntry!.toState(),
        second.entry.toState(),
        third.entry.toState(),
      ]),
    );
    expect(plain(next.map((entry) => entry.toState()))).toEqual(
      plain([second.entry.toState()]),
    );
    expect(none).toEqual([]);
  });

  test('reads the entries after several cursors in one call, wallet by wallet', async () => {
    const first = openedWallet('100.00');
    const second = openedWallet('50.00');
    for (const opened of [first, second]) {
      await harness.unitOfWork.run((scope) => storeOpenedWallet(scope, opened));
    }
    const bets = [
      settledBet(first.wallet, '1.00'),
      settledBet(first.wallet, '2.00'),
      settledBet(second.wallet, '3.00'),
    ];
    await harness.unitOfWork.run(async ({ transactions, ledger }) => {
      for (const { bet, entry } of bets) {
        await transactions.insert(bet);
        await ledger.append(entry);
      }
    });
    const cursors = [
      { walletId: first.wallet.id, afterVersion: 1 },
      { walletId: second.wallet.id, afterVersion: 0 },
    ];

    const all = await harness.unitOfWork.run(({ ledger }) =>
      ledger.afterMany(cursors, 10),
    );
    const limited = await harness.unitOfWork.run(({ ledger }) =>
      ledger.afterMany(cursors, 3),
    );
    const none = await harness.unitOfWork.run(({ ledger }) =>
      ledger.afterMany([], 10),
    );

    expect(all.map((entry) => [entry.walletId, entry.walletVersion])).toEqual([
      [first.wallet.id, 2],
      [first.wallet.id, 3],
      [second.wallet.id, 1],
      [second.wallet.id, 2],
    ]);
    expect(
      limited.map((entry) => [entry.walletId, entry.walletVersion]),
    ).toEqual([
      [first.wallet.id, 2],
      [first.wallet.id, 3],
      [second.wallet.id, 1],
    ]);
    expect(none).toEqual([]);
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
