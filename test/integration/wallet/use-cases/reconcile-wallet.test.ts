import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rejectionOf } from '@test/support/async';
import { commandFor } from '@test/support/commands';
import { insertRow } from '@test/support/database';
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
const { Bet, Win } = WagerTransactionKind;

beforeAll(async () => {
  harness = await createPersistenceHarness();
  wagering = createWagering(harness.unitOfWork);
});

afterAll(async () => {
  await harness.close();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

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
    });
  });

  test('reconciles a wallet that never moved', async () => {
    const wallet = await openWalletWith(wagering, '0.00');

    expect(await wagering.reconcile.execute(wallet.id)).toMatchObject({
      calculatedBalance: brl('0.00'),
      consistent: true,
      checkedEntries: 0,
    });
  });

  test('flags a stored balance that drifted from the ledger without fixing it', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    await harness.database
      .sql`update wallets set balance_amount = '101.50' where id = ${wallet.id}`;

    const report = await wagering.reconcile.execute(wallet.id);

    expect(report).toMatchObject({
      storedBalance: brl('101.50'),
      calculatedBalance: brl('100.00'),
      difference: brl('1.50'),
      consistent: false,
    });
    const [stored] = await harness.database
      .sql`select balance_amount::text as balance from wallets where id = ${wallet.id}`;
    expect(stored.balance).toBe('101.50');
  });

  test('reports a negative calculated balance when the ledger is corrupted', async () => {
    const wallet = await openWalletWith(wagering, '50.00');
    const walletRow = {
      id: wallet.id,
      player_id: wallet.playerId,
      currency: 'BRL',
    };
    const bet = transactionRow(walletRow, {
      amount: '100.00',
      result_balance_amount: '0.00',
    });
    await insertRow(harness.database.sql, 'wager_transactions', bet);
    await insertRow(
      harness.database.sql,
      'wallet_ledger_entries',
      ledgerRow(bet, {
        wallet_version: 2,
        amount: '100.00',
        balance_before: '100.00',
        balance_after: '0.00',
      }),
    );

    expect(await wagering.reconcile.execute(wallet.id)).toEqual({
      walletId: wallet.id,
      storedBalance: brl('50.00'),
      calculatedBalance: brl('-50.00'),
      difference: brl('100.00'),
      consistent: false,
      checkedEntries: 2,
    });
  });

  test('reports an unknown wallet as not found', async () => {
    expect(
      await rejectionOf(wagering.reconcile.execute(Bun.randomUUIDv7())),
    ).toBeInstanceOf(WalletNotFoundError);
  });
});
