import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { migrateDown, migrateUp } from '@platform/database/migrator';
import { migrations } from '@platform/database/migrations';
import { Migration20261003140000AllowBalanceLimitFailureCode } from '@platform/database/migrations/migration-20261003140000-allow-balance-limit-failure-code';
import { createOrm } from '@platform/database/orm';
import { type TestDatabase, createTestDatabase } from '@test/support/database';

const SCHEMA_TABLES = [
  'inbox_messages',
  'maintenance_leases',
  'outbox_messages',
  'wager_transactions',
  'wallet_ledger_entries',
  'wallets',
];
const SCHEMA_FUNCTIONS = [
  'check_ledger_entry_chain',
  'check_wallet_matches_ledger',
  'guard_wager_transaction_update',
  'reject_mutation',
];

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

async function schemaTables(): Promise<string[]> {
  const rows: { table_name: string }[] = await database.sql`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_name <> 'mikro_orm_migrations'
    order by table_name`;
  return rows.map((row) => row.table_name);
}

async function schemaFunctions(): Promise<string[]> {
  const rows: { proname: string }[] = await database.sql`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
    order by p.proname`;
  return rows.map((row) => row.proname);
}

async function runMigrateCommand(
  command: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(
    ['bun', 'src/platform/database/migrate.ts', command],
    {
      env: { ...process.env, DATABASE_URL: database.url },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe('wagering schema migrations', () => {
  test('apply, revert and apply again on a fresh database', async () => {
    expect(await migrateUp(database.url)).toHaveLength(migrations.length);
    expect(await schemaTables()).toEqual(SCHEMA_TABLES);
    expect(await schemaFunctions()).toEqual(SCHEMA_FUNCTIONS);

    expect(await migrateDown(database.url)).toHaveLength(migrations.length);
    expect(await schemaTables()).toEqual([]);
    expect(await schemaFunctions()).toEqual([]);

    expect(await migrateUp(database.url)).toHaveLength(migrations.length);
    expect(await schemaTables()).toEqual(SCHEMA_TABLES);
    expect(await schemaFunctions()).toEqual(SCHEMA_FUNCTIONS);
  });

  test('build the inbox retention index without a transaction, valid and ready', async () => {
    await migrateUp(database.url);

    const [index] = await database.sql`
      select i.indisvalid as valid, i.indisready as ready
      from pg_index i join pg_class c on c.oid = i.indexrelid
      where c.relname = 'inbox_messages_received_at'`;

    expect(index).toEqual({ valid: true, ready: true });
  });

  test('replace the failure-code check without validating the table under an exclusive lock', async () => {
    await migrateUp(database.url);
    const orm = await createOrm({ databaseUrl: database.url, entities: [] });
    try {
      const migration = new Migration20261003140000AllowBalanceLimitFailureCode(
        orm.em.getDriver(),
        orm.config,
      );
      await migration.up();
      const statements = migration
        .getQueries()
        .map((query) => String(query).replace(/\s+/g, ' ').trim());

      expect(migration.isTransactional()).toBe(false);
      expect(statements).toHaveLength(2);
      expect(statements[0]).toStartWith(
        'alter table wager_transactions drop constraint wager_transactions_failure_code_known, add constraint wager_transactions_failure_code_known check',
      );
      expect(statements[0]).toEndWith(' not valid');
      expect(statements[1]).toBe(
        'alter table wager_transactions validate constraint wager_transactions_failure_code_known',
      );
    } finally {
      await orm.close(true);
    }
    const [constraint] = await database.sql`
      select convalidated from pg_constraint where conname = 'wager_transactions_failure_code_known'`;
    expect(constraint).toEqual({ convalidated: true });
  });

  test('apply nothing when the schema is already current', async () => {
    await migrateUp(database.url);

    expect(await migrateUp(database.url)).toEqual([]);
  });
});

describe('migrate command', () => {
  test('reverts and applies the schema of the database in DATABASE_URL', async () => {
    await migrateUp(database.url);

    const down = await runMigrateCommand('down');
    expect(down.exitCode).toBe(0);
    expect(JSON.parse(down.stdout)).toMatchObject({
      level: 'info',
      msg: 'migrations reverted',
    });
    expect(await schemaTables()).toEqual([]);

    const up = await runMigrateCommand('up');
    expect(up.exitCode).toBe(0);
    expect(JSON.parse(up.stdout)).toMatchObject({
      level: 'info',
      msg: 'migrations applied',
    });
    expect(await schemaTables()).toEqual(SCHEMA_TABLES);
  });

  test('refuses an unknown command', async () => {
    const result = await runMigrateCommand('sideways');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('usage');
  });
});
