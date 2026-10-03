import { parseArgs } from 'node:util';
import { SQL } from 'bun';
import { RECONCILIATION_SQL } from '@wallet/infrastructure/persistence/mikro-orm-ledger-repository';
import { LOAD_DATABASE_URL } from './infra';
import { percentile } from './stats';

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Relation Name'?: string;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
}

interface Measured {
  name: string;
  medianMs: number;
  maxMs: number;
  access: string;
  hit: number;
  read: number;
}

function accessOf(node: PlanNode): string[] {
  const own =
    node['Index Name'] !== undefined
      ? [`${node['Node Type']} ${node['Index Name']}`]
      : node['Node Type'].includes('Scan') && node['Relation Name']
        ? [`${node['Node Type']} ${node['Relation Name']}`]
        : [];
  return [...own, ...(node.Plans ?? []).flatMap(accessOf)];
}

async function measure(
  sql: SQL,
  name: string,
  query: string,
  params: unknown[],
  runs: number,
): Promise<Measured> {
  const timings: number[] = [];
  let plan: PlanNode | undefined;
  let hit = 0;
  let read = 0;
  for (let run = 0; run < runs; run += 1) {
    await sql
      .begin(async (tx) => {
        const [row] = await tx.unsafe(
          `explain (analyze, buffers, format json) ${query}`,
          params,
        );
        const [result] = row['QUERY PLAN'] as {
          Plan: PlanNode;
          'Execution Time': number;
        }[];
        timings.push(result!['Execution Time']);
        plan = result!.Plan;
        hit = result!.Plan['Shared Hit Blocks'] ?? 0;
        read = result!.Plan['Shared Read Blocks'] ?? 0;
        throw new Error('rollback');
      })
      .catch((error: Error) => {
        if (error.message !== 'rollback') {
          throw error;
        }
      });
  }
  return {
    name,
    medianMs: percentile(
      [...timings].sort((left, right) => left - right),
      0.5,
    ),
    maxMs: Math.max(...timings),
    access: [...new Set(plan === undefined ? [] : accessOf(plan))].join(', '),
    hit,
    read,
  };
}

const { values } = parseArgs({
  options: {
    database: { type: 'string' },
    runs: { type: 'string', default: '20' },
  },
});
if (values.database === undefined) {
  process.stderr.write(
    'usage: bun test/load/plans.ts --database <name> [--runs 20]\n',
  );
  process.exit(1);
}
const url = new URL(LOAD_DATABASE_URL);
url.pathname = `/${values.database}`;
const sql = new SQL({ url: url.toString(), max: 1 });
const runs = Number(values.runs);

const [sample] = await sql`
  select w.id, w.version, t.idempotency_key, t.provider_id, t.external_transaction_id
  from wallets w
  join wager_transactions t on t.wallet_id = w.id and t.kind <> 'OPENING'
  order by random() limit 1`;
const [hot] = await sql`
  select id, version from wallets order by version desc limit 1`;
const watched: { id: string }[] =
  await sql`select id from wallets order by random() limit 100`;

const checks: [string, string, unknown[]][] = [
  [
    'lock the wallet',
    'select * from wallets where id = $1 for update',
    [sample.id],
  ],
  [
    'find a transaction by idempotency key',
    'select * from wager_transactions where idempotency_key = $1',
    [sample.idempotency_key],
  ],
  [
    'find a transaction by provider and external id',
    'select * from wager_transactions where provider_id = $1 and external_transaction_id = $2',
    [sample.provider_id, sample.external_transaction_id],
  ],
  [
    'page the ledger (51 newest)',
    'select * from wallet_ledger_entries where wallet_id = $1 order by wallet_version desc limit 51',
    [sample.id],
  ],
  [
    'read the ledger after a version (stream)',
    'select * from wallet_ledger_entries where wallet_id = $1 and wallet_version > $2 order by wallet_version limit 100',
    [sample.id, 1],
  ],
  [
    'reconcile a wallet',
    RECONCILIATION_SQL.replaceAll('?', () => '$1'),
    [sample.id],
  ],
  [
    `reconcile the longest wallet (${hot.version} versions)`,
    RECONCILIATION_SQL.replaceAll('?', () => '$1'),
    [hot.id],
  ],
  [
    'record an inbox message',
    "insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values ('wager-transactions-consumer', $1, repeat('a', 64), now()) on conflict do nothing",
    [`msg-plan-${Date.now()}`],
  ],
  [
    'claim the due outbox batch',
    'select * from outbox_messages where published_at is null and next_attempt_at <= now() order by next_attempt_at, id limit 10 for update skip locked',
    [],
  ],
  [
    'pick due pending references',
    "select * from wager_transactions where status = 'PENDING_REFERENCE' and next_reference_attempt_at <= now() order by next_reference_attempt_at, id limit 20 for update skip locked",
    [],
  ],
  [
    'versions of 100 watched wallets (stream sweep)',
    'select id, version from wallets where id = any($1::uuid[])',
    [`{${watched.map((row) => row.id).join(',')}}`],
  ],
];

const results: Measured[] = [];
for (const [name, query, params] of checks) {
  results.push(await measure(sql, name, query, params, runs));
}
const sizes: { relation: string; rows: number; total: string }[] = await sql`
  select c.relname as relation, c.reltuples::bigint as rows,
    pg_size_pretty(pg_total_relation_size(c.oid)) as total
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
  order by pg_total_relation_size(c.oid) desc`;
await sql.close();

process.stdout.write(
  [
    `Database ${values.database}, ${runs} runs per query (median and max of the server execution time).`,
    '',
    '| Query | Median ms | Max ms | Access | Buffers hit/read (last run) |',
    '|---|---|---|---|---|',
    ...results.map(
      (item) =>
        `| ${item.name} | ${item.medianMs.toFixed(3)} | ${item.maxMs.toFixed(3)} | ${item.access} | ${item.hit}/${item.read} |`,
    ),
    '',
    '| Table | Rows (estimate) | Size with indexes |',
    '|---|---|---|',
    ...sizes.map((row) => `| ${row.relation} | ${row.rows} | ${row.total} |`),
    '',
  ].join('\n'),
);
