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
  inboxRow,
  outboxRow,
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

const insertInbox = (row: Row) =>
  insertRow(database.sql, 'inbox_messages', row);
const insertOutbox = (row: Row) =>
  insertRow(database.sql, 'outbox_messages', row);

describe('inbox_messages table', () => {
  test('records a message linked to the transaction it produced', async () => {
    const wallet = walletRow();
    await insertRow(database.sql, 'wallets', wallet);
    const transaction = transactionRow(wallet);
    await insertRow(database.sql, 'wager_transactions', transaction);

    await insertInbox(inboxRow({ transaction_id: transaction.id }));
  });

  test.each(requiredColumns(inboxRow(), ['transaction_id', 'processed_at']))(
    'requires %s',
    async (column) => {
      expect(
        await nullViolationOf(insertInbox(inboxRow({ [column]: null }))),
      ).toEqual({
        sqlState: SqlState.NotNullViolation,
        column,
      });
    },
  );

  test.each([
    [
      'an empty consumer name',
      { consumer_name: '' },
      'inbox_messages_consumer_name_length',
    ],
    [
      'a consumer name longer than 128 characters',
      { consumer_name: 'c'.repeat(129) },
      'inbox_messages_consumer_name_length',
    ],
    [
      'an empty message id',
      { message_id: '' },
      'inbox_messages_message_id_length',
    ],
    [
      'a message id longer than 255 characters',
      { message_id: 'm'.repeat(256) },
      'inbox_messages_message_id_length',
    ],
    [
      'a payload hash that is not hex SHA-256',
      { payload_hash: 'xyz' },
      'inbox_messages_payload_hash_format',
    ],
  ] as const)('rejects %s', async (_, overrides, constraint) => {
    expect(await violationOf(insertInbox(inboxRow(overrides)))).toEqual({
      sqlState: SqlState.CheckViolation,
      constraint,
    });
  });

  test('records a message once per consumer', async () => {
    const message = inboxRow();
    await insertInbox(message);

    expect(
      await violationOf(
        insertInbox(inboxRow({ message_id: message.message_id })),
      ),
    ).toEqual({
      sqlState: SqlState.UniqueViolation,
      constraint: 'inbox_messages_pkey',
    });
  });

  test('lets another consumer record the same message', async () => {
    const message = inboxRow();
    await insertInbox(message);

    await insertInbox(
      inboxRow({ message_id: message.message_id, consumer_name: 'audit' }),
    );
  });

  test('requires an existing transaction when linked to one', async () => {
    expect(
      await violationOf(
        insertInbox(inboxRow({ transaction_id: Bun.randomUUIDv7() })),
      ),
    ).toEqual({
      sqlState: SqlState.ForeignKeyViolation,
      constraint: 'inbox_messages_transaction_fkey',
    });
  });
});

describe('outbox_messages table', () => {
  test('stores the event envelope as JSON', async () => {
    const message = outboxRow();

    await insertOutbox(message);

    const [stored] =
      await database.sql`select payload from outbox_messages where id = ${message.id}`;
    expect(stored.payload).toEqual(message.payload);
  });

  test.each(requiredColumns(outboxRow(), ['published_at', 'last_error']))(
    'requires %s',
    async (column) => {
      expect(
        await nullViolationOf(insertOutbox(outboxRow({ [column]: null }))),
      ).toEqual({
        sqlState: SqlState.NotNullViolation,
        column,
      });
    },
  );

  test.each([
    [
      'an empty event type',
      { event_type: '' },
      'outbox_messages_event_type_length',
    ],
    [
      'event version zero',
      { event_version: 0 },
      'outbox_messages_event_version_positive',
    ],
    [
      'an empty message group id',
      { message_group_id: '' },
      'outbox_messages_message_group_id_length',
    ],
    [
      'a message group id longer than 128 characters',
      { message_group_id: 'g'.repeat(129) },
      'outbox_messages_message_group_id_length',
    ],
    [
      'negative attempts',
      { attempts: -1 },
      'outbox_messages_attempts_non_negative',
    ],
    [
      'an error longer than 500 characters',
      { last_error: 'x'.repeat(501) },
      'outbox_messages_last_error_length',
    ],
  ] as const)('rejects %s', async (_, overrides, constraint) => {
    expect(await violationOf(insertOutbox(outboxRow(overrides)))).toEqual({
      sqlState: SqlState.CheckViolation,
      constraint,
    });
  });

  test('stores an event once', async () => {
    const message = outboxRow();
    await insertOutbox(message);

    expect(
      await violationOf(insertOutbox(outboxRow({ id: message.id }))),
    ).toEqual({
      sqlState: SqlState.UniqueViolation,
      constraint: 'outbox_messages_pkey',
    });
  });
});
