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

let database: TestDatabase;

beforeAll(async () => {
  database = await createMigratedDatabase();
});

afterAll(async () => {
  await database.drop();
});

const lease = (overrides: Row = {}): Row => ({
  name: `job-${Bun.randomUUIDv7()}`,
  holder: 'worker-1',
  expires_at: new Date(),
  ...overrides,
});

const insertLease = (row: Row) =>
  insertRow(database.sql, 'maintenance_leases', row);

describe('maintenance_leases table', () => {
  test.each(['name', 'holder', 'expires_at'])('requires %s', async (column) => {
    expect(
      await nullViolationOf(insertLease(lease({ [column]: null }))),
    ).toEqual({ sqlState: SqlState.NotNullViolation, column });
  });

  test.each([
    ['an empty name', { name: '' }, 'maintenance_leases_name_length'],
    [
      'a name above 64 characters',
      { name: 'n'.repeat(65) },
      'maintenance_leases_name_length',
    ],
    ['an empty holder', { holder: '' }, 'maintenance_leases_holder_length'],
    [
      'a holder above 255 characters',
      { holder: 'h'.repeat(256) },
      'maintenance_leases_holder_length',
    ],
  ] as const)('rejects %s', async (_, overrides, constraint) => {
    expect(await violationOf(insertLease(lease(overrides)))).toEqual({
      sqlState: SqlState.CheckViolation,
      constraint,
    });
  });

  test('keeps one lease per name', async () => {
    const first = lease();
    await insertLease(first);

    expect(await violationOf(insertLease(lease({ name: first.name })))).toEqual(
      {
        sqlState: SqlState.UniqueViolation,
        constraint: 'maintenance_leases_pkey',
      },
    );
  });
});
