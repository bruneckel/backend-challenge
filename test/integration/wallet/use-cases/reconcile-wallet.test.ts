import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import type { LogFields } from '@shared/application/logger';
import { inconsistentWallets } from '@test/support/invariants';
import { rejectionOf } from '@test/support/async';
import { commandFor } from '@test/support/commands';
import { insertRow } from '@test/support/database';
import { bypassingLedgerGuards } from '@test/support/ledger-states';
import { RecordingMetrics } from '@test/support/recording-metrics';
import {
  type PersistenceHarness,
  createPersistenceHarness,
} from '@test/support/persistence';
import { ledgerRow, transactionRow } from '@test/support/schema-rows';
import {
  type Wagering,
  createWagering,
  openWalletWith,
} from '@test/support/wagering';
import { WalletNotFoundError } from '@wallet/application/errors';
import { WagerTransactionKind } from '@wallet/domain/transaction/wager-transaction';

let harness: PersistenceHarness;
let wagering: Wagering;
const corruptedOnPurpose: string[] = [];
const { Bet, Win } = WagerTransactionKind;

beforeAll(async () => {
  harness = await createPersistenceHarness();
  wagering = createWagering(harness.unitOfWork);
});

afterEach(async () => {
  expect(
    await inconsistentWallets(harness.database.sql, corruptedOnPurpose),
  ).toEqual([]);
});

afterAll(async () => {
  await harness.close();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function breakChainOf<T extends { id: string; playerId: string }>(
  wallet: T,
): Promise<T> {
  corruptedOnPurpose.push(wallet.id);
  const walletRow = {
    id: wallet.id,
    player_id: wallet.playerId,
    currency: 'BRL',
  };
  const bet = transactionRow(walletRow, {
    amount: '10.00',
    result_balance_amount: '90.00',
  });
  const win = transactionRow(walletRow, {
    kind: 'WIN',
    amount: '10.00',
    result_balance_amount: '90.00',
  });
  await bypassingLedgerGuards(harness.database.sql, async (tx) => {
    for (const row of [bet, win]) {
      await insertRow(tx, 'wager_transactions', row);
    }
    await insertRow(
      tx,
      'wallet_ledger_entries',
      ledgerRow(bet, {
        wallet_version: 2,
        direction: 'DEBIT',
        amount: '10.00',
        balance_before: '100.00',
        balance_after: '90.00',
      }),
    );
    await insertRow(
      tx,
      'wallet_ledger_entries',
      ledgerRow(win, {
        wallet_version: 3,
        direction: 'CREDIT',
        amount: '10.00',
        balance_before: '80.00',
        balance_after: '90.00',
      }),
    );
    await tx`update wallets set version = 3 where id = ${wallet.id}`;
  });
  return wallet;
}

describe('ReconcileWallet', () => {
  test('confirms a wallet whose balance matches its ledger', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    await wagering.submit.execute(commandFor(wallet, Bet, '30.00'));
    await wagering.submit.execute(commandFor(wallet, Win, '10.00'));

    expect(await wagering.reconcile.execute(wallet.id)).toEqual({
      walletId: wallet.id,
      storedBalance: brl('80.00'),
      calculatedBalance: brl('80.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 3,
      chainBreaks: 0,
      versionConsistent: true,
    });
  });

  test('reconciles a wallet that never moved', async () => {
    const wallet = await openWalletWith(wagering, '0.00');

    expect(await wagering.reconcile.execute(wallet.id)).toMatchObject({
      calculatedBalance: brl('0.00'),
      consistent: true,
      checkedEntries: 0,
      chainBreaks: 0,
      versionConsistent: true,
    });
  });

  test('flags a stored balance that drifted from the ledger without fixing it', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    corruptedOnPurpose.push(wallet.id);
    await bypassingLedgerGuards(
      harness.database.sql,
      (tx) =>
        tx`update wallets set balance_amount = '101.50' where id = ${wallet.id}`,
    );

    const report = await wagering.reconcile.execute(wallet.id);

    expect(report).toMatchObject({
      storedBalance: brl('101.50'),
      calculatedBalance: brl('100.00'),
      difference: brl('1.50'),
      consistent: false,
      chainBreaks: 0,
      versionConsistent: true,
    });
    const [stored] = await harness.database
      .sql`select balance_amount::text as balance from wallets where id = ${wallet.id}`;
    expect(stored.balance).toBe('101.50');
  });

  test('reports a negative calculated balance when the ledger is corrupted', async () => {
    const wallet = await openWalletWith(wagering, '50.00');
    corruptedOnPurpose.push(wallet.id);
    const walletRow = {
      id: wallet.id,
      player_id: wallet.playerId,
      currency: 'BRL',
    };
    const bet = transactionRow(walletRow, {
      amount: '100.00',
      result_balance_amount: '0.00',
    });
    await bypassingLedgerGuards(harness.database.sql, async (tx) => {
      await insertRow(tx, 'wager_transactions', bet);
      await insertRow(
        tx,
        'wallet_ledger_entries',
        ledgerRow(bet, {
          wallet_version: 2,
          amount: '100.00',
          balance_before: '100.00',
          balance_after: '0.00',
        }),
      );
    });

    expect(await wagering.reconcile.execute(wallet.id)).toEqual({
      walletId: wallet.id,
      storedBalance: brl('50.00'),
      calculatedBalance: brl('-50.00'),
      difference: brl('100.00'),
      consistent: false,
      checkedEntries: 2,
      chainBreaks: 1,
      versionConsistent: false,
    });
  });

  test('flags a broken ledger chain even when the sums still match', async () => {
    const wallet = await breakChainOf(await openWalletWith(wagering, '100.00'));

    expect(await wagering.reconcile.execute(wallet.id)).toEqual({
      walletId: wallet.id,
      storedBalance: brl('100.00'),
      calculatedBalance: brl('100.00'),
      difference: brl('0.00'),
      consistent: false,
      checkedEntries: 3,
      chainBreaks: 1,
      versionConsistent: true,
    });
  });

  test('flags a stored version that does not match the ledger', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    await wagering.submit.execute(commandFor(wallet, Bet, '30.00'));
    corruptedOnPurpose.push(wallet.id);
    await bypassingLedgerGuards(
      harness.database.sql,
      (tx) => tx`update wallets set version = 5 where id = ${wallet.id}`,
    );

    expect(await wagering.reconcile.execute(wallet.id)).toMatchObject({
      difference: brl('0.00'),
      consistent: false,
      chainBreaks: 0,
      versionConsistent: false,
    });
  });

  test('counts and logs each kind of divergence without amounts', async () => {
    const metrics = new RecordingMetrics();
    const logs: { message: string; fields: LogFields }[] = [];
    const record = (message: string, fields: LogFields = {}) =>
      logs.push({ message, fields });
    const observed = createWagering(harness.unitOfWork, 3, {
      metrics,
      logger: { info: record, warn: record, error: record },
    });
    const wallet = await breakChainOf(await openWalletWith(observed, '100.00'));
    await bypassingLedgerGuards(
      harness.database.sql,
      (tx) =>
        tx`update wallets set version = 7, balance_amount = '99.00' where id = ${wallet.id}`,
    );

    await observed.reconcile.execute(wallet.id);

    expect(
      metrics.count('wallet_reconciliations_total', { result: 'divergent' }),
    ).toBe(1);
    for (const kind of ['balance', 'chain', 'version']) {
      expect(
        metrics.count('wallet_reconciliation_divergences_total', { kind }),
      ).toBe(1);
    }
    expect(logs.map((entry) => entry.message)).toEqual([
      'wallet balance diverges from its ledger',
      'wallet ledger chain is broken',
      'wallet version diverges from its ledger',
    ]);
    expect(logs[1]?.fields).toEqual({ walletId: wallet.id, chainBreaks: 1 });
    expect(JSON.stringify(logs)).not.toContain('99.00');
  });

  test('reports an unknown wallet as not found', async () => {
    expect(
      await rejectionOf(wagering.reconcile.execute(Bun.randomUUIDv7())),
    ).toBeInstanceOf(WalletNotFoundError);
  });
});
