import { afterAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import {
  type SeedSpec,
  ensureSeedTemplate,
  sampleSeededWallets,
  seedTemplateName,
} from '@test/load/seed';
import { DATABASE_URL } from '@test/support/database';
import { inconsistentWallets } from '@test/support/invariants';

const spec: SeedSpec = {
  wallets: 1_000 + Math.floor(Math.random() * 1_000),
  operations: 3,
  hotEntries: 50,
  events: true,
};
const admin = new SQL(DATABASE_URL);

afterAll(async () => {
  await admin.unsafe(
    `drop database if exists ${seedTemplateName(spec)} with (force)`,
  );
  await admin.close();
});

function urlOf(database: string): string {
  const url = new URL(DATABASE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

describe('load seed', () => {
  test('builds a coherent template of wallets, transactions, ledger, inbox and published events', async () => {
    const name = await ensureSeedTemplate(spec, {
      adminUrl: DATABASE_URL,
      chunk: 400,
    });
    const sql = new SQL(urlOf(name));
    try {
      const [counts] = await sql`
        select
          (select count(*)::int from wallets) as wallets,
          (select count(*)::int from wager_transactions) as transactions,
          (select count(*)::int from wallet_ledger_entries) as entries,
          (select count(*)::int from inbox_messages) as inbox,
          (select count(*)::int from outbox_messages) as outbox,
          (select count(*)::int from outbox_messages where published_at is null) as pending`;
      const transactions = spec.wallets * 4 + 51;

      expect(counts).toEqual({
        wallets: spec.wallets + 1,
        transactions,
        entries: transactions,
        inbox: spec.wallets + 25,
        outbox: transactions * 2,
        pending: 0,
      });
      expect(await inconsistentWallets(sql)).toEqual([]);
      const [future] = await sql`
        select
          (select count(*)::int from wallets where updated_at > now()) as wallets,
          (select count(*)::int from wager_transactions where updated_at > now()) as transactions,
          (select count(*)::int from wallet_ledger_entries where created_at > now()) as entries,
          (select count(*)::int from inbox_messages where processed_at > now()) as inbox,
          (select count(*)::int from outbox_messages where published_at > now()) as outbox`;
      expect(future).toEqual({
        wallets: 0,
        transactions: 0,
        entries: 0,
        inbox: 0,
        outbox: 0,
      });
      const correlations = await sql`
        select tablename || '.' || attname as "column", correlation
        from pg_stats
        where (tablename, attname) in (
          ('outbox_messages', 'id'),
          ('inbox_messages', 'received_at'),
          ('wallet_ledger_entries', 'created_at'))`;
      expect(correlations).toHaveLength(3);
      expect(
        correlations.filter(
          (row: { correlation: number }) => row.correlation < 0.99,
        ),
      ).toEqual([]);
      const [mismatched] = await sql`
        select count(*)::int as count from outbox_messages
        where abs(extract(epoch from uuid_extract_timestamp(id) - occurred_at)) > 1`;
      expect(mismatched.count).toBe(0);
      const { hot, wallets } = await sampleSeededWallets(sql, 10);
      const [hotWallet] =
        await sql`select version, balance_amount::text as balance from wallets where id = ${hot.id}`;
      expect(hotWallet).toEqual({ version: 51, balance: '1000.00' });
      expect(wallets).toHaveLength(10);
      expect(wallets.every((wallet) => wallet.id !== hot.id)).toBe(true);
    } finally {
      await sql.close();
    }
  });

  test('reuses a template that already exists', async () => {
    const started = performance.now();

    const name = await ensureSeedTemplate(spec, { adminUrl: DATABASE_URL });

    expect(name).toBe(seedTemplateName(spec));
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
