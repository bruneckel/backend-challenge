import { SQL } from 'bun';
import { migrateUp } from '@platform/database/migrator';
import { rejectionOf } from './async';

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://wagering:wagering@localhost:5432/wagering';

export const SqlState = {
  RestrictViolation: '23001',
  NotNullViolation: '23502',
  ForeignKeyViolation: '23503',
  UniqueViolation: '23505',
  CheckViolation: '23514',
} as const;

export type Row = Record<string, unknown>;

export interface TestDatabase {
  readonly url: string;
  readonly sql: SQL;
  drop(): Promise<void>;
}

export interface Violation {
  sqlState: unknown;
  constraint?: unknown;
}

export interface NullViolation {
  sqlState: unknown;
  column: unknown;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `wagering_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new SQL(DATABASE_URL);
  await admin.unsafe(`create database ${name}`);
  const url = new URL(DATABASE_URL);
  url.pathname = `/${name}`;
  const sql = new SQL(url.toString());
  return {
    url: url.toString(),
    sql,
    async drop() {
      await sql.close();
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.close();
    },
  };
}

export async function createMigratedDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabase();
  await migrateUp(database.url);
  return database;
}

export function insertRow(sql: SQL, table: string, row: Row): PromiseLike<unknown> {
  return sql`insert into ${sql(table)} ${sql(row)}`;
}

async function databaseRejectionOf(write: PromiseLike<unknown>): Promise<Record<string, unknown>> {
  return (await rejectionOf(write)) as Record<string, unknown>;
}

export async function violationOf(write: PromiseLike<unknown>): Promise<Violation> {
  const { errno, constraint } = await databaseRejectionOf(write);
  return { sqlState: errno, constraint };
}

export async function nullViolationOf(write: PromiseLike<unknown>): Promise<NullViolation> {
  const { errno, column } = await databaseRejectionOf(write);
  return { sqlState: errno, column };
}
