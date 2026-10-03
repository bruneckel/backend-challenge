import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { outboxEventsSince } from '@test/load/collectors';
import {
  type TestDatabase,
  createMigratedDatabase,
  insertRow,
} from '@test/support/database';
import { outboxRow } from '@test/support/schema-rows';

let database: TestDatabase;

beforeAll(async () => {
  database = await createMigratedDatabase();
});

afterAll(async () => {
  await database.drop();
});

describe('load collectors', () => {
  test('count only the outbox events created since the scenario started', async () => {
    const startedAt = new Date();
    const seededAt = new Date(startedAt.getTime() - 3_600_000);
    await insertRow(
      database.sql,
      'outbox_messages',
      outboxRow({
        id: Bun.randomUUIDv7('hex', seededAt),
        occurred_at: seededAt,
        published_at: seededAt,
      }),
    );
    await insertRow(
      database.sql,
      'outbox_messages',
      outboxRow({
        id: Bun.randomUUIDv7('hex', new Date(startedAt.getTime() + 1)),
      }),
    );

    expect(await outboxEventsSince(database.sql, startedAt)).toBe(1);
  });
});
