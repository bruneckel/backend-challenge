import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type Row,
  SqlState,
  type TestDatabase,
  createMigratedDatabase,
  insertRow,
  nullViolationOf,
  violationOf,
} from '@test/support/database';
import {
  ledgerRow,
  rejected,
  requiredColumns,
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

async function storedWallet(): Promise<Row> {
  const wallet = walletRow();
  await insertRow(database.sql, 'wallets', wallet);
  return wallet;
}

async function storedTransaction(
  wallet: Row,
  overrides: Row = {},
): Promise<Row> {
  const transaction = transactionRow(wallet, overrides);
  await insertRow(database.sql, 'wager_transactions', transaction);
  return transaction;
}

async function storedBet(): Promise<Row> {
  return storedTransaction(await storedWallet());
}

const insertEntry = (row: Row) =>
  insertRow(database.sql, 'wallet_ledger_entries', row);

async function storedEntry(): Promise<Row> {
  const entry = ledgerRow(await storedBet());
  await insertEntry(entry);
  return entry;
}

describe('wallet_ledger_entries shapes', () => {
  test.each([
    ['a debit', {}],
    ['a credit', { direction: 'CREDIT', balance_after: '110.00' }],
    [
      'a credit that opens a wallet',
      {
        direction: 'CREDIT',
        wallet_version: 1,
        balance_before: '0.00',
        balance_after: '10.00',
      },
    ],
  ] as const)('accepts %s that adds up', async (_, overrides) => {
    const entry = ledgerRow(await storedBet(), overrides);

    await insertEntry(entry);

    const [stored] =
      await database.sql`select amount::text as amount, balance_after::text as balance_after from wallet_ledger_entries where id = ${entry.id}`;
    expect(stored).toEqual({
      amount: entry.amount,
      balance_after: entry.balance_after,
    });
  });

  test.each(requiredColumns(ledgerRow(transactionRow(walletRow()))))(
    'requires %s',
    async (column) => {
      expect(
        await nullViolationOf(
          insertEntry(ledgerRow(await storedBet(), { [column]: null })),
        ),
      ).toEqual({
        sqlState: SqlState.NotNullViolation,
        column,
      });
    },
  );
});

describe('wallet_ledger_entries checks', () => {
  test.each([
    [
      'wallet version zero',
      { wallet_version: 0 },
      'wallet_ledger_entries_wallet_version_positive',
    ],
    [
      'an unknown direction',
      { direction: 'SIDEWAYS' },
      'wallet_ledger_entries_direction_known',
    ],
    [
      'a zero amount',
      { amount: '0.00', balance_after: '100.00' },
      'wallet_ledger_entries_amount_money',
    ],
    [
      'an amount with one decimal',
      { amount: '10.0' },
      'wallet_ledger_entries_amount_money',
    ],
    [
      'a negative balance before',
      { direction: 'CREDIT', balance_before: '-10.00', balance_after: '0.00' },
      'wallet_ledger_entries_balance_before_money',
    ],
    [
      'a negative balance after',
      { balance_before: '5.00', balance_after: '-5.00' },
      'wallet_ledger_entries_balance_after_money',
    ],
    [
      'a balance after of 10^17',
      {
        direction: 'CREDIT',
        balance_before: '99999999999999990.00',
        balance_after: '100000000000000000.00',
      },
      'wallet_ledger_entries_balance_after_money',
    ],
    [
      'a debit that does not add up',
      { balance_after: '91.00' },
      'wallet_ledger_entries_arithmetic',
    ],
    [
      'a credit that does not add up',
      { direction: 'CREDIT' },
      'wallet_ledger_entries_arithmetic',
    ],
  ] as const)('rejects %s', async (_, overrides, constraint) => {
    expect(
      await violationOf(insertEntry(ledgerRow(await storedBet(), overrides))),
    ).toEqual({
      sqlState: SqlState.CheckViolation,
      constraint,
    });
  });
});

describe('wallet_ledger_entries references', () => {
  test('requires the currency of the wallet', async () => {
    const wallet = await storedWallet();
    const foreign = await storedTransaction(wallet, {
      ...rejected,
      failure_code: 'CURRENCY_MISMATCH',
      currency: 'USD',
    });

    expect(await violationOf(insertEntry(ledgerRow(foreign)))).toEqual({
      sqlState: SqlState.ForeignKeyViolation,
      constraint: 'wallet_ledger_entries_wallet_currency_fkey',
    });
  });

  test('requires the currency of the transaction', async () => {
    const wallet = await storedWallet();
    const foreign = await storedTransaction(wallet, {
      ...rejected,
      failure_code: 'CURRENCY_MISMATCH',
      currency: 'USD',
    });

    expect(
      await violationOf(insertEntry(ledgerRow(foreign, { currency: 'BRL' }))),
    ).toEqual({
      sqlState: SqlState.ForeignKeyViolation,
      constraint: 'wallet_ledger_entries_transaction_fkey',
    });
  });

  test('requires a transaction of the same wallet', async () => {
    const bet = await storedBet();
    const otherWallet = await storedWallet();

    expect(
      await violationOf(
        insertEntry(ledgerRow(bet, { wallet_id: otherWallet.id })),
      ),
    ).toEqual({
      sqlState: SqlState.ForeignKeyViolation,
      constraint: 'wallet_ledger_entries_transaction_fkey',
    });
  });

  test('requires an existing transaction', async () => {
    const bet = await storedBet();

    expect(
      await violationOf(
        insertEntry(ledgerRow(bet, { transaction_id: Bun.randomUUIDv7() })),
      ),
    ).toEqual({
      sqlState: SqlState.ForeignKeyViolation,
      constraint: 'wallet_ledger_entries_transaction_fkey',
    });
  });
});

describe('wallet_ledger_entries uniqueness', () => {
  test('refuses a second entry with the same id', async () => {
    const entry = await storedEntry();

    expect(
      await violationOf(
        insertEntry(ledgerRow(await storedBet(), { id: entry.id })),
      ),
    ).toEqual({
      sqlState: SqlState.UniqueViolation,
      constraint: 'wallet_ledger_entries_pkey',
    });
  });

  test('keeps at most one entry per transaction', async () => {
    const bet = await storedBet();
    await insertEntry(ledgerRow(bet));

    const again = ledgerRow(bet, {
      wallet_version: 3,
      balance_before: '90.00',
      balance_after: '80.00',
    });

    expect(await violationOf(insertEntry(again))).toEqual({
      sqlState: SqlState.UniqueViolation,
      constraint: 'wallet_ledger_entries_wallet_transaction_key',
    });
  });

  test('keeps at most one entry per wallet version', async () => {
    const wallet = await storedWallet();
    await insertEntry(ledgerRow(await storedTransaction(wallet)));

    const sameVersion = ledgerRow(await storedTransaction(wallet));

    expect(await violationOf(insertEntry(sameVersion))).toEqual({
      sqlState: SqlState.UniqueViolation,
      constraint: 'wallet_ledger_entries_wallet_version_key',
    });
  });
});

describe('wallet_ledger_entries history', () => {
  test('refuses to update an entry', async () => {
    const entry = await storedEntry();

    expect(
      await violationOf(
        database.sql`update wallet_ledger_entries set created_at = now() where id = ${entry.id}`,
      ),
    ).toEqual({
      sqlState: SqlState.RestrictViolation,
    });
  });

  test('refuses to delete an entry', async () => {
    const entry = await storedEntry();

    expect(
      await violationOf(
        database.sql`delete from wallet_ledger_entries where id = ${entry.id}`,
      ),
    ).toEqual({
      sqlState: SqlState.RestrictViolation,
    });
  });

  test('refuses to truncate the ledger', async () => {
    await storedEntry();

    expect(
      await violationOf(database.sql`truncate wallet_ledger_entries`),
    ).toEqual({
      sqlState: SqlState.RestrictViolation,
    });
  });
});
