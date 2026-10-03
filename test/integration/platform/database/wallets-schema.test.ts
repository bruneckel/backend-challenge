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
import { storeWallet } from '@test/support/ledger-states';
import { requiredColumns, walletRow } from '@test/support/schema-rows';

let database: TestDatabase;

beforeAll(async () => {
  database = await createMigratedDatabase();
});

afterAll(async () => {
  await database.drop();
});

const insertWallet = (row: Row) => insertRow(database.sql, 'wallets', row);

describe('wallets table', () => {
  test('stores the balance as an exact decimal string up to the magnitude limit', async () => {
    const wallet = await storeWallet(database.sql, {
      balance_amount: '99999999999999999.99',
    });

    const [stored] =
      await database.sql`select balance_amount::text as balance_amount from wallets where id = ${wallet.id}`;
    expect(stored.balance_amount).toBe('99999999999999999.99');
  });

  test.each(requiredColumns(walletRow()))('requires %s', async (column) => {
    expect(
      await nullViolationOf(insertWallet(walletRow({ [column]: null }))),
    ).toEqual({
      sqlState: SqlState.NotNullViolation,
      column,
    });
  });

  test.each([
    ['a lowercase currency', { currency: 'brl' }, 'wallets_currency_format'],
    ['a two-letter currency', { currency: 'BR' }, 'wallets_currency_format'],
    [
      'a balance with three decimals',
      { balance_amount: '10.005' },
      'wallets_balance_amount_money',
    ],
    [
      'a balance with one decimal',
      { balance_amount: '10.0' },
      'wallets_balance_amount_money',
    ],
    [
      'a negative balance',
      { balance_amount: '-0.01' },
      'wallets_balance_amount_money',
    ],
    [
      'a balance of 10^17',
      { balance_amount: '100000000000000000.00' },
      'wallets_balance_amount_money',
    ],
    ['version zero', { version: 0 }, 'wallets_version_positive'],
  ] as const)('rejects %s', async (_, overrides, constraint) => {
    expect(await violationOf(insertWallet(walletRow(overrides)))).toEqual({
      sqlState: SqlState.CheckViolation,
      constraint,
    });
  });

  test('refuses a second wallet with the same id', async () => {
    const wallet = await storeWallet(database.sql);

    expect(
      await violationOf(
        insertWallet(walletRow({ id: wallet.id, currency: 'USD' })),
      ),
    ).toEqual({
      sqlState: SqlState.UniqueViolation,
      constraint: 'wallets_pkey',
    });
  });

  test('keeps a single wallet per player and currency', async () => {
    const wallet = await storeWallet(database.sql);

    expect(
      await violationOf(
        insertWallet(walletRow({ player_id: wallet.player_id })),
      ),
    ).toEqual({
      sqlState: SqlState.UniqueViolation,
      constraint: 'wallets_player_currency_key',
    });
  });

  test('lets a player hold wallets in different currencies', async () => {
    const wallet = await storeWallet(database.sql);

    await storeWallet(database.sql, {
      player_id: wallet.player_id,
      currency: 'USD',
    });

    const [{ count }] =
      await database.sql`select count(*)::int as count from wallets where player_id = ${wallet.player_id}`;
    expect(count).toBe(2);
  });
});
