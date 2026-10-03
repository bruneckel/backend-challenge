import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { DATABASE_URL, dropStaleTestDatabases } from '@test/support/database';

let admin: SQL;
const created: string[] = [];

beforeAll(() => {
  admin = new SQL(DATABASE_URL);
});

afterAll(async () => {
  for (const name of created) {
    await admin.unsafe(`drop database if exists ${name} with (force)`);
  }
  await admin.close();
});

async function databaseCreatedAt(at: number): Promise<string> {
  const name = `wagering_test_${at.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await admin.unsafe(`create database ${name}`);
  created.push(name);
  return name;
}

async function exists(name: string): Promise<boolean> {
  const rows = await admin`select 1 from pg_database where datname = ${name}`;
  return rows.length === 1;
}

describe('stale test databases', () => {
  test('are dropped once they are older than ten minutes', async () => {
    const now = Date.now();
    const stale = await databaseCreatedAt(now - 11 * 60_000);
    const recent = await databaseCreatedAt(now - 60_000);

    await dropStaleTestDatabases(admin, now);

    expect(await exists(stale)).toBe(false);
    expect(await exists(recent)).toBe(true);
  });

  test('are left alone while something is still connected to them', async () => {
    const now = Date.now();
    const busy = await databaseCreatedAt(now - 60 * 60_000);
    const url = new URL(DATABASE_URL);
    url.pathname = `/${busy}`;
    const connection = new SQL(url.toString());
    await connection`select 1`;

    try {
      await dropStaleTestDatabases(admin, now);

      expect(await exists(busy)).toBe(true);
    } finally {
      await connection.close();
    }
  });
});
