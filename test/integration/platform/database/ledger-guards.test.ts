import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import {
  type Row,
  SqlState,
  type TestDatabase,
  createMigratedDatabase,
  violationOf,
} from '@test/support/database';
import { storeMovement, storeWallet } from '@test/support/ledger-states';
import {
  ledgerRow,
  transactionRow,
  walletRow,
} from '@test/support/schema-rows';

let database: TestDatabase;

beforeAll(async () => {
  database = await createMigratedDatabase();
});

afterAll(async () => {
  await database.drop();
});

const WALLET_GUARD = {
  sqlState: SqlState.CheckViolation,
  constraint: 'wallets_balance_matches_ledger',
};
const CHAIN_GUARD = {
  sqlState: SqlState.CheckViolation,
  constraint: 'wallet_ledger_entries_follow_chain',
};

async function walletState(wallet: Row): Promise<Row> {
  const [row] = await database.sql`
    select balance_amount::text as balance, version from wallets where id = ${wallet.id}`;
  return row;
}

function inTransaction(work: (tx: SQL) => Promise<unknown>): Promise<unknown> {
  return database.sql.begin(work);
}

describe('wallet balance and ledger guards', () => {
  test('accept a wallet opened with a balance and its opening entry', async () => {
    const wallet = await storeWallet(database.sql);

    expect(await walletState(wallet)).toEqual({
      balance: '100.00',
      version: 1,
    });
  });

  test('accept a wallet opened with a zero balance and no entry', async () => {
    const wallet = await storeWallet(database.sql, { balance_amount: '0.00' });

    expect(await walletState(wallet)).toEqual({ balance: '0.00', version: 1 });
  });

  test('accept a movement that follows the entry of the current version', async () => {
    const wallet = await storeWallet(database.sql);

    await storeMovement(database.sql, wallet, transactionRow(wallet));

    expect(await walletState(wallet)).toEqual({ balance: '90.00', version: 2 });
  });

  test('accept the first movement of a zero-balance wallet at version 2', async () => {
    const wallet = await storeWallet(database.sql, { balance_amount: '0.00' });
    const win = transactionRow(wallet, {
      kind: 'WIN',
      amount: '50.00',
      result_balance_amount: '50.00',
    });

    await storeMovement(database.sql, wallet, win, {
      direction: 'CREDIT',
      amount: '50.00',
      balance_before: '0.00',
      balance_after: '50.00',
    });

    expect(await walletState(wallet)).toEqual({ balance: '50.00', version: 2 });
  });

  test('accept the wallet written before its entry in the same transaction', async () => {
    const wallet = await storeWallet(database.sql);
    const bet = transactionRow(wallet);

    await inTransaction(async (tx) => {
      await tx`update wallets set balance_amount = '90.00', version = 2 where id = ${wallet.id}`;
      await tx`insert into wager_transactions ${tx(bet)}`;
      await tx`insert into wallet_ledger_entries ${tx(ledgerRow(bet))}`;
    });

    expect(await walletState(wallet)).toEqual({ balance: '90.00', version: 2 });
  });

  test('accept two movements of a wallet in one transaction', async () => {
    const wallet = await storeWallet(database.sql);
    const first = transactionRow(wallet);
    const second = transactionRow(wallet, { result_balance_amount: '80.00' });

    await inTransaction(async (tx) => {
      await tx`insert into wager_transactions ${tx(first)}`;
      await tx`insert into wallet_ledger_entries ${tx(ledgerRow(first))}`;
      await tx`update wallets set balance_amount = '90.00', version = 2 where id = ${wallet.id}`;
      await tx`insert into wager_transactions ${tx(second)}`;
      await tx`insert into wallet_ledger_entries ${tx(
        ledgerRow(second, {
          wallet_version: 3,
          balance_before: '90.00',
          balance_after: '80.00',
        }),
      )}`;
      await tx`update wallets set balance_amount = '80.00', version = 3 where id = ${wallet.id}`;
    });

    expect(await walletState(wallet)).toEqual({ balance: '80.00', version: 3 });
  });

  test('refuse a wallet opened with a balance and no entry', async () => {
    expect(
      await violationOf(
        inTransaction((tx) => tx`insert into wallets ${tx(walletRow())}`),
      ),
    ).toEqual(WALLET_GUARD);
  });

  test('refuse a balance that differs from the entry of the version', async () => {
    const wallet = await storeWallet(database.sql);

    expect(
      await violationOf(
        database.sql`update wallets set balance_amount = '99.00' where id = ${wallet.id}`,
      ),
    ).toEqual(WALLET_GUARD);
    expect(await walletState(wallet)).toEqual({
      balance: '100.00',
      version: 1,
    });
  });

  test('refuse a version moved without an entry', async () => {
    const wallet = await storeWallet(database.sql);

    expect(
      await violationOf(
        database.sql`update wallets set version = 2 where id = ${wallet.id}`,
      ),
    ).toEqual(WALLET_GUARD);
  });

  test('refuse an entry that does not start from the previous balance', async () => {
    const wallet = await storeWallet(database.sql);

    expect(
      await violationOf(
        storeMovement(database.sql, wallet, transactionRow(wallet), {
          balance_before: '90.00',
          balance_after: '80.00',
        }),
      ),
    ).toEqual(CHAIN_GUARD);
  });

  test('refuse an entry that skips a version', async () => {
    const wallet = await storeWallet(database.sql);

    expect(
      await violationOf(
        storeMovement(
          database.sql,
          wallet,
          transactionRow(wallet, {
            kind: 'WIN',
            result_balance_amount: '10.00',
          }),
          {
            wallet_version: 3,
            direction: 'CREDIT',
            balance_before: '0.00',
            balance_after: '10.00',
          },
        ),
      ),
    ).toEqual(CHAIN_GUARD);
  });

  test('refuse a first entry that does not start from zero', async () => {
    const wallet = await storeWallet(database.sql, { balance_amount: '0.00' });

    expect(
      await violationOf(
        storeMovement(
          database.sql,
          wallet,
          transactionRow(wallet, { result_balance_amount: '90.00' }),
        ),
      ),
    ).toEqual(CHAIN_GUARD);
  });

  test('refuse an entry ahead of its wallet', async () => {
    const wallet = await storeWallet(database.sql);
    const bet = transactionRow(wallet);

    expect(
      await violationOf(
        inTransaction(async (tx) => {
          await tx`insert into wager_transactions ${tx(bet)}`;
          await tx`insert into wallet_ledger_entries ${tx(ledgerRow(bet))}`;
        }),
      ),
    ).toEqual(CHAIN_GUARD);
    expect(await walletState(wallet)).toEqual({
      balance: '100.00',
      version: 1,
    });
  });
});
