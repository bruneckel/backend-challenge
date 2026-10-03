import { SQL } from 'bun';
import { migrateUp } from '@platform/database/migrator';
import { inconsistentWallets } from '@test/support/invariants';
import type { LoadWallet } from '@test/support/load';

export interface SeedSpec {
  wallets: number;
  operations: number;
  hotEntries: number;
  events: boolean;
}

export interface SeedOptions {
  adminUrl: string;
  log?: (message: string) => void;
  chunk?: number;
}

const DEFAULT_CHUNK = 100_000;

export function seedTemplateName(spec: SeedSpec): string {
  return `load_seed_${spec.wallets}_${spec.operations}_${spec.hotEntries}_${spec.events ? 'events' : 'plain'}`;
}

function databaseUrl(adminUrl: string, database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

const integer = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`seed parameter ${value} must be a non-negative integer`);
  }
  return value;
};

function chunkSql(
  from: number,
  to: number,
  operations: number,
  events: boolean,
): string {
  const versions = integer(operations) + 1;
  const finalBalance = versions % 2 === 0 ? '999.00' : '1000.00';
  return `
    create temporary table seed_wallets on commit drop as
      select n, uuidv7() as id, uuidv7() as player_id,
        now() - (n % 30) * interval '1 day' - (n % 86400) * interval '1 second' as created_at
      from generate_series(${integer(from)}, ${integer(to)}) as n;

    insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
      select id, player_id, 'BRL', ${finalBalance}, ${versions}, created_at,
        created_at + ${versions} * interval '1 minute'
      from seed_wallets;

    create temporary table seed_steps on commit drop as
      select w.n, w.id as wallet_id, w.player_id, s.v,
        uuidv7() as transaction_id, uuidv7() as entry_id,
        w.created_at + s.v * interval '1 minute' as at
      from seed_wallets w cross join generate_series(1, ${versions}) as s(v);

    insert into wager_transactions (
      id, provider_id, external_transaction_id, idempotency_key, payload_hash,
      wallet_id, player_id, round_id, game_id, kind, amount, currency,
      reference_external_transaction_id, correlation_id, status, failure_code,
      reference_transaction_id, processed_at, result_balance_amount,
      result_balance_currency, reference_attempts, next_reference_attempt_at,
      created_at, updated_at)
    select transaction_id,
      case when v = 1 then 'internal' else 'provider-seed' end,
      case when v = 1 then 'opening:' || wallet_id else 'seed-' || n || '-' || v end,
      case when v = 1 then 'opening:' || wallet_id else 'provider-seed:seed-' || n || '-' || v end,
      md5(transaction_id::text) || md5(wallet_id::text),
      wallet_id, player_id,
      case when v = 1 then 'opening' else 'round-' || v end,
      case when v = 1 then 'internal' else 'seed-game' end,
      case when v = 1 then 'OPENING' when v % 2 = 0 then 'BET' else 'WIN' end,
      case when v = 1 then 1000.00 else 1.00 end,
      'BRL', null, 'seed', 'PROCESSED', null, null, at,
      case when v % 2 = 0 then 999.00 else 1000.00 end,
      'BRL', 0, null, at, at
    from seed_steps;

    insert into wallet_ledger_entries (
      id, wallet_id, transaction_id, wallet_version, direction, amount,
      currency, balance_before, balance_after, created_at)
    select entry_id, wallet_id, transaction_id, v,
      case when v % 2 = 0 then 'DEBIT' else 'CREDIT' end,
      case when v = 1 then 1000.00 else 1.00 end,
      'BRL',
      case when v = 1 then 0.00 when v % 2 = 0 then 1000.00 else 999.00 end,
      case when v % 2 = 0 then 999.00 else 1000.00 end,
      at
    from seed_steps;

    insert into inbox_messages (
      consumer_name, message_id, payload_hash, transaction_id, received_at, processed_at)
    select 'wager-transactions-consumer', 'msg-seed-' || n || '-' || v,
      md5(transaction_id::text) || md5(n::text), transaction_id, at, at
    from seed_steps
    where v > 1 and v % 2 = 1;
    ${
      events
        ? `
    insert into outbox_messages (
      id, aggregate_id, event_type, event_version, message_group_id, payload,
      occurred_at, attempts, next_attempt_at, published_at, last_error)
    select uuidv7(at - now()), transaction_id, e.type, 1, wallet_id::text,
      jsonb_build_object(
        'eventId', uuidv7(), 'eventType', e.type, 'version', 1,
        'occurredAt', at, 'aggregateId', transaction_id, 'correlationId', 'seed',
        'data', jsonb_build_object(
          'walletId', wallet_id, 'transactionId', transaction_id, 'walletVersion', v,
          'money', jsonb_build_object('amount', case when v = 1 then '1000.00' else '1.00' end, 'currency', 'BRL'),
          'balanceAfter', jsonb_build_object('amount', case when v % 2 = 0 then '999.00' else '1000.00' end, 'currency', 'BRL'))),
      at, 1, at, at + interval '1 second', null
    from seed_steps
    cross join (values ('WagerTransactionProcessed'), ('WalletBalanceChanged')) as e(type);`
        : ''
    }`;
}

async function databaseExists(admin: SQL, name: string): Promise<boolean> {
  const rows = await admin`select 1 from pg_database where datname = ${name}`;
  return rows.length === 1;
}

export async function ensureSeedTemplate(
  spec: SeedSpec,
  options: SeedOptions,
): Promise<string> {
  const log = options.log ?? (() => undefined);
  const chunk = options.chunk ?? DEFAULT_CHUNK;
  const name = seedTemplateName(spec);
  const building = `${name}_building`;
  const admin = new SQL(options.adminUrl);
  try {
    if (await databaseExists(admin, name)) {
      return name;
    }
    await admin.unsafe(`drop database if exists ${building} with (force)`);
    await admin.unsafe(`create database ${building}`);
    await migrateUp(databaseUrl(options.adminUrl, building));
    const sql = new SQL({
      url: databaseUrl(options.adminUrl, building),
      max: 1,
    });
    try {
      const started = performance.now();
      for (let from = 1; from <= spec.wallets; from += chunk) {
        const to = Math.min(spec.wallets, from + chunk - 1);
        await sql.begin((tx) =>
          tx.unsafe(chunkSql(from, to, spec.operations, spec.events)),
        );
        log(
          `  seeded ${to} of ${spec.wallets} wallets (${Math.round((performance.now() - started) / 1000)} s)`,
        );
      }
      if (spec.hotEntries > 0) {
        await sql.begin((tx) =>
          tx.unsafe(chunkSql(0, 0, spec.hotEntries, spec.events)),
        );
        log(`  seeded a hot wallet with ${spec.hotEntries + 1} entries`);
      }
      await sql.unsafe('analyze');
      const violations = await inconsistentWallets(sql);
      if (violations.length > 0) {
        throw new Error(
          `the seed broke ${violations.length} wallet invariants: ${violations[0]}`,
        );
      }
      log(
        `  seed checked and ready in ${Math.round((performance.now() - started) / 1000)} s`,
      );
    } finally {
      await sql.close();
    }
    await admin.unsafe(`alter database ${building} rename to ${name}`);
    return name;
  } catch (error) {
    await admin
      .unsafe(`drop database if exists ${building} with (force)`)
      .catch(() => undefined);
    throw error;
  } finally {
    await admin.close();
  }
}

export async function sampleSeededWallets(
  sql: SQL,
  size: number,
): Promise<{ hot: LoadWallet; wallets: LoadWallet[] }> {
  const [hot] = await sql`
    select id, player_id as "playerId" from wallets order by version desc, id limit 1`;
  const wallets: LoadWallet[] = await sql`
    select id, player_id as "playerId" from wallets
    where id <> ${hot.id}
    order by random()
    limit ${size}`;
  return { hot, wallets };
}
