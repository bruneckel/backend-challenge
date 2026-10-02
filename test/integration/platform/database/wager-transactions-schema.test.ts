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
  AT,
  LATER,
  failed,
  openingOf,
  pendingReference,
  rejected,
  requiredColumns,
  referencing,
  transactionRow,
  walletRow,
} from '@test/support/schema-rows';

const NULLABLE_COLUMNS = [
  'reference_external_transaction_id',
  'failure_code',
  'reference_transaction_id',
  'processed_at',
  'result_balance_amount',
  'result_balance_currency',
  'next_reference_attempt_at',
];

let database: TestDatabase;
let wallet: Row;

beforeAll(async () => {
  database = await createMigratedDatabase();
  wallet = await storedWallet();
});

afterAll(async () => {
  await database.drop();
});

async function storedWallet(overrides: Row = {}): Promise<Row> {
  const row = walletRow(overrides);
  await insertRow(database.sql, 'wallets', row);
  return row;
}

const insertTransaction = (row: Row) => insertRow(database.sql, 'wager_transactions', row);
const transaction = (overrides: Row = {}) => transactionRow(wallet, overrides);

async function stored(overrides: Row = {}): Promise<Row> {
  const row = transaction(overrides);
  await insertTransaction(row);
  return row;
}

const updateTransaction = (row: Row, changes: Row) =>
  database.sql`update wager_transactions set ${database.sql(changes)} where id = ${row.id}`;

describe('wager_transactions shapes', () => {
  test.each([
    ['a processed BET', {}],
    ['a rejected BET', rejected],
    ['a failed BET without an observed balance', failed],
    ['a failed BET that kept its observed balance', { ...failed, result_balance_amount: '90.00', result_balance_currency: 'BRL' }],
    ['a LOSS of zero', { kind: 'LOSS', amount: '0.00', result_balance_amount: '100.00' }],
    ['a WIN without a reference', { kind: 'WIN', result_balance_amount: '110.00' }],
    ['a REFUND waiting for its reference', pendingReference],
    ['a WIN waiting for its reference', { ...pendingReference, kind: 'WIN' }],
    ['a transaction rejected for using another currency', { ...rejected, failure_code: 'CURRENCY_MISMATCH', currency: 'USD' }],
  ] as const)('accepts %s', async (_, overrides) => {
    const row = transaction(overrides);

    await insertTransaction(row);

    const [storedRow] = await database.sql`select status, amount::text as amount from wager_transactions where id = ${row.id}`;
    expect(storedRow).toEqual({ status: row.status, amount: row.amount });
  });

  test('accepts the internal OPENING of a wallet', async () => {
    const fresh = await storedWallet();

    await insertTransaction(transactionRow(fresh, openingOf(fresh)));
  });

  test.each(requiredColumns(transactionRow(walletRow()), NULLABLE_COLUMNS))('requires %s', async (column) => {
    expect(await nullViolationOf(insertTransaction(transaction({ [column]: null })))).toEqual({
      sqlState: SqlState.NotNullViolation,
      column,
    });
  });
});

describe('wager_transactions checks', () => {
  test.each([
    ['an empty provider id', { provider_id: '' }, 'wager_transactions_provider_id_length'],
    ['a provider id longer than 64 characters', { provider_id: 'p'.repeat(65) }, 'wager_transactions_provider_id_length'],
    ['an empty external transaction id', { external_transaction_id: '' }, 'wager_transactions_external_transaction_id_length'],
    [
      'an external transaction id longer than 128 characters',
      { external_transaction_id: 'e'.repeat(129) },
      'wager_transactions_external_transaction_id_length',
    ],
    ['an empty idempotency key', { idempotency_key: '' }, 'wager_transactions_idempotency_key_length'],
    ['an idempotency key longer than 255 characters', { idempotency_key: 'k'.repeat(256) }, 'wager_transactions_idempotency_key_length'],
    ['an uppercase payload hash', { payload_hash: 'A'.repeat(64) }, 'wager_transactions_payload_hash_format'],
    ['a short payload hash', { payload_hash: 'a'.repeat(63) }, 'wager_transactions_payload_hash_format'],
    ['an empty round id', { round_id: '' }, 'wager_transactions_round_id_length'],
    ['a game id longer than 128 characters', { game_id: 'g'.repeat(129) }, 'wager_transactions_game_id_length'],
    ['an unknown kind', { kind: 'JACKPOT' }, 'wager_transactions_kind_known'],
    ['an amount with three decimals', { amount: '10.001' }, 'wager_transactions_amount_money'],
    ['a negative LOSS', { kind: 'LOSS', amount: '-10.00' }, 'wager_transactions_amount_money'],
    ['an amount of 10^17', { amount: '100000000000000000.00' }, 'wager_transactions_amount_money'],
    ['a BET of zero', { amount: '0.00' }, 'wager_transactions_amount_positive'],
    ['a lowercase currency', { currency: 'brl' }, 'wager_transactions_currency_format'],
    [
      'an empty reference external transaction id',
      { ...rejected, kind: 'WIN', reference_external_transaction_id: '' },
      'wager_transactions_reference_external_transaction_id_length',
    ],
    ['an empty correlation id', { correlation_id: '' }, 'wager_transactions_correlation_id_length'],
    ['the in-memory PENDING status', { status: 'PENDING', processed_at: null }, 'wager_transactions_status_persisted'],
    ['an unknown status', { status: 'DONE', processed_at: null }, 'wager_transactions_status_persisted'],
    ['an unknown failure code', { ...rejected, failure_code: 'OOPS' }, 'wager_transactions_failure_code_known'],
    ['a result balance with three decimals', { result_balance_amount: '90.001' }, 'wager_transactions_result_balance_amount_money'],
    ['a negative result balance', { result_balance_amount: '-1.00' }, 'wager_transactions_result_balance_amount_money'],
    ['a lowercase result balance currency', { result_balance_currency: 'brl' }, 'wager_transactions_result_balance_currency_format'],
    ['negative reference attempts', { reference_attempts: -1 }, 'wager_transactions_reference_attempts_non_negative'],
    ['a REFUND without a reference', { kind: 'REFUND' }, 'wager_transactions_reference_required'],
    ['a ROLLBACK without a reference', { kind: 'ROLLBACK' }, 'wager_transactions_reference_required'],
    ['a BET with a reference', { ...rejected, reference_external_transaction_id: 'ext-1' }, 'wager_transactions_reference_forbidden'],
    ['a REJECTED transaction without a failure code', { ...rejected, failure_code: null }, 'wager_transactions_failure_code_status'],
    ['a FAILED transaction without a failure code', { ...failed, failure_code: null }, 'wager_transactions_failure_code_status'],
    ['a PROCESSED transaction with a failure code', { failure_code: 'INSUFFICIENT_FUNDS' }, 'wager_transactions_failure_code_status'],
    ['a PROCESSED transaction without processed_at', { processed_at: null }, 'wager_transactions_processed_at_status'],
    ['a REJECTED transaction with processed_at', { ...rejected, processed_at: AT }, 'wager_transactions_processed_at_status'],
    [
      'a PENDING_REFERENCE transaction without a next attempt',
      { ...pendingReference, next_reference_attempt_at: null },
      'wager_transactions_schedule_status',
    ],
    ['a PROCESSED transaction with a next attempt', { next_reference_attempt_at: LATER }, 'wager_transactions_schedule_status'],
    [
      'a PROCESSED REFUND without its resolved reference',
      { kind: 'REFUND', reference_external_transaction_id: 'ext-1' },
      'wager_transactions_reference_resolution',
    ],
    [
      'a PROCESSED WIN without its resolved reference',
      { kind: 'WIN', reference_external_transaction_id: 'ext-1' },
      'wager_transactions_reference_resolution',
    ],
    ['a result balance amount without its currency', { result_balance_currency: null }, 'wager_transactions_result_balance_pair'],
    ['a result balance currency without its amount', { ...failed, result_balance_currency: 'BRL' }, 'wager_transactions_result_balance_pair'],
    [
      'a PROCESSED transaction without a result balance',
      { result_balance_amount: null, result_balance_currency: null },
      'wager_transactions_result_balance_known',
    ],
    [
      'a REJECTED transaction without a result balance',
      { ...rejected, result_balance_amount: null, result_balance_currency: null },
      'wager_transactions_result_balance_known',
    ],
    [
      'a PENDING_REFERENCE transaction without a result balance',
      { ...pendingReference, result_balance_amount: null, result_balance_currency: null },
      'wager_transactions_result_balance_known',
    ],
    ['a BET from the reserved internal provider', { provider_id: 'internal' }, 'wager_transactions_internal_provider_opening'],
    ['an OPENING from an external provider', { kind: 'OPENING' }, 'wager_transactions_internal_provider_opening'],
  ] as const)('rejects %s', async (_, overrides, constraint) => {
    expect(await violationOf(insertTransaction(transaction(overrides)))).toEqual({
      sqlState: SqlState.CheckViolation,
      constraint,
    });
  });

  test('rejects a transaction that references itself', async () => {
    const row = transaction({ kind: 'REFUND', reference_external_transaction_id: 'ext-1' });
    row.reference_transaction_id = row.id;

    expect(await violationOf(insertTransaction(row))).toEqual({
      sqlState: SqlState.CheckViolation,
      constraint: 'wager_transactions_not_self_reference',
    });
  });

  test('rejects a resolved reference on a transaction that was not processed', async () => {
    const bet = await stored();

    expect(await violationOf(insertTransaction(transaction({ ...referencing(bet, 'REFUND'), ...rejected })))).toEqual({
      sqlState: SqlState.CheckViolation,
      constraint: 'wager_transactions_reference_resolution',
    });
  });

  test('rejects a resolved reference on a transaction that declared none', async () => {
    const bet = await stored();

    expect(await violationOf(insertTransaction(transaction({ reference_transaction_id: bet.id })))).toEqual({
      sqlState: SqlState.CheckViolation,
      constraint: 'wager_transactions_reference_resolution',
    });
  });
});

describe('wager_transactions references', () => {
  test('requires an existing wallet', async () => {
    expect(await violationOf(insertTransaction(transactionRow(walletRow(), failed)))).toEqual({
      sqlState: SqlState.ForeignKeyViolation,
      constraint: 'wager_transactions_wallet_fkey',
    });
  });

  test('requires the observed balance in the currency of the wallet', async () => {
    expect(await violationOf(insertTransaction(transaction({ result_balance_currency: 'USD' })))).toEqual({
      sqlState: SqlState.ForeignKeyViolation,
      constraint: 'wager_transactions_result_balance_currency_fkey',
    });
  });

  test('requires an existing reference transaction', async () => {
    const row = transaction({
      kind: 'REFUND',
      reference_external_transaction_id: 'ext-1',
      reference_transaction_id: Bun.randomUUIDv7(),
    });

    expect(await violationOf(insertTransaction(row))).toEqual({
      sqlState: SqlState.ForeignKeyViolation,
      constraint: 'wager_transactions_reference_transaction_fkey',
    });
  });
});

describe('wager_transactions uniqueness', () => {
  test('refuses a second transaction with the same id', async () => {
    const first = await stored();

    expect(await violationOf(insertTransaction(transaction({ id: first.id, currency: 'USD' })))).toEqual({
      sqlState: SqlState.UniqueViolation,
      constraint: 'wager_transactions_pkey',
    });
  });

  test('refuses a second transaction with the same idempotency key', async () => {
    const first = await stored();

    expect(await violationOf(insertTransaction(transaction({ idempotency_key: first.idempotency_key })))).toEqual({
      sqlState: SqlState.UniqueViolation,
      constraint: 'wager_transactions_idempotency_key_key',
    });
  });

  test('refuses the same idempotency key from another provider', async () => {
    const first = await stored();

    const sameKeyOtherProvider = transaction({ provider_id: 'provider-b', idempotency_key: first.idempotency_key });

    expect(await violationOf(insertTransaction(sameKeyOtherProvider))).toEqual({
      sqlState: SqlState.UniqueViolation,
      constraint: 'wager_transactions_idempotency_key_key',
    });
  });

  test('refuses a second transaction with the same provider and external id', async () => {
    const first = await stored();

    expect(await violationOf(insertTransaction(transaction({ external_transaction_id: first.external_transaction_id })))).toEqual({
      sqlState: SqlState.UniqueViolation,
      constraint: 'wager_transactions_provider_external_key',
    });
  });

  test('lets two providers use the same external id', async () => {
    const first = await stored();

    await insertTransaction(transaction({ provider_id: 'provider-b', external_transaction_id: first.external_transaction_id }));
  });

  test('accepts one processed reversal of each kind for the same reference', async () => {
    const bet = await stored();

    await insertTransaction(transaction(referencing(bet, 'REFUND')));
    await insertTransaction(transaction(referencing(bet, 'ROLLBACK')));
  });

  test.each(['REFUND', 'ROLLBACK'] as const)('refuses a second processed %s of the same reference', async (kind) => {
    const bet = await stored();
    await insertTransaction(transaction(referencing(bet, kind)));

    expect(await violationOf(insertTransaction(transaction(referencing(bet, kind))))).toEqual({
      sqlState: SqlState.UniqueViolation,
      constraint: 'wager_transactions_one_reversal_per_kind',
    });
  });

  test('lets several WINs settle the same BET', async () => {
    const bet = await stored();
    const winOf = () => transaction(referencing(bet, 'WIN', { amount: '5.00' }));

    await insertTransaction(winOf());
    await insertTransaction(winOf());
  });

  test('refuses a second OPENING for the same wallet', async () => {
    const fresh = await storedWallet();
    await insertTransaction(transactionRow(fresh, openingOf(fresh)));

    const second = transactionRow(
      fresh,
      openingOf(fresh, { external_transaction_id: 'opening:again', idempotency_key: 'opening:again' }),
    );

    expect(await violationOf(insertTransaction(second))).toEqual({
      sqlState: SqlState.UniqueViolation,
      constraint: 'wager_transactions_one_opening_per_wallet',
    });
  });
});

describe('wager_transactions history', () => {
  test('refuses to delete a transaction', async () => {
    const row = await stored();

    expect(await violationOf(database.sql`delete from wager_transactions where id = ${row.id}`)).toEqual({
      sqlState: SqlState.RestrictViolation,
    });
  });

  test('refuses to truncate transactions even when cascading', async () => {
    await stored();

    expect(await violationOf(database.sql`truncate wager_transactions cascade`)).toEqual({
      sqlState: SqlState.RestrictViolation,
    });
  });

  test.each([
    ['PROCESSED', {}],
    ['REJECTED', rejected],
    ['FAILED', failed],
  ] as const)('refuses any update to a %s transaction', async (_, shape) => {
    const row = await stored(shape);

    expect(await violationOf(updateTransaction(row, { updated_at: LATER }))).toEqual({
      sqlState: SqlState.RestrictViolation,
    });
  });

  test.each([
    ['id', Bun.randomUUIDv7()],
    ['provider_id', 'provider-b'],
    ['external_transaction_id', 'ext-changed'],
    ['idempotency_key', 'key-changed'],
    ['payload_hash', 'b'.repeat(64)],
    ['wallet_id', Bun.randomUUIDv7()],
    ['player_id', Bun.randomUUIDv7()],
    ['round_id', 'round-2'],
    ['game_id', 'other-game'],
    ['kind', 'ROLLBACK'],
    ['amount', '11.00'],
    ['currency', 'USD'],
    ['reference_external_transaction_id', 'ext-other'],
    ['correlation_id', 'correlation-2'],
    ['created_at', LATER],
  ] as const)('refuses to change %s of a waiting transaction', async (column, value) => {
    const row = await stored(pendingReference);

    expect(await violationOf(updateTransaction(row, { [column]: value }))).toEqual({
      sqlState: SqlState.RestrictViolation,
    });
  });

  test('lets a waiting transaction schedule another attempt', async () => {
    const row = await stored(pendingReference);

    await updateTransaction(row, { reference_attempts: 1, next_reference_attempt_at: LATER, updated_at: LATER });

    const [storedRow] = await database.sql`select reference_attempts from wager_transactions where id = ${row.id}`;
    expect(storedRow.reference_attempts).toBe(1);
  });

  test('lets a waiting transaction be processed once its reference arrives', async () => {
    const bet = await stored();
    const refund = await stored({ ...pendingReference, amount: bet.amount, reference_external_transaction_id: bet.external_transaction_id });

    await updateTransaction(refund, {
      status: 'PROCESSED',
      reference_transaction_id: bet.id,
      processed_at: LATER,
      next_reference_attempt_at: null,
      result_balance_amount: '110.00',
      updated_at: LATER,
    });

    const [storedRow] = await database.sql`select status from wager_transactions where id = ${refund.id}`;
    expect(storedRow.status).toBe('PROCESSED');
  });

  test.each([
    ['rejected', { status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND' }],
    ['failed', { status: 'FAILED', failure_code: 'PROCESSING_FAILED' }],
  ] as const)('lets a waiting transaction be %s', async (_, outcome) => {
    const row = await stored(pendingReference);

    await updateTransaction(row, { ...outcome, next_reference_attempt_at: null, updated_at: LATER });

    const [storedRow] = await database.sql`select status from wager_transactions where id = ${row.id}`;
    expect(storedRow.status).toBe(outcome.status);
  });
});
