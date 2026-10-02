import type { SQL } from 'bun';

export interface InvariantViolation {
  walletId: string;
  message: string;
}

export async function invariantViolations(
  sql: SQL,
): Promise<InvariantViolation[]> {
  const violations: InvariantViolation[] = [];
  const drifted = await sql`
    select w.id, w.balance_amount::text as stored, coalesce(s.rebuilt, 0)::text as rebuilt
    from wallets w
    left join (
      select wallet_id, sum(case direction when 'CREDIT' then amount else -amount end) as rebuilt
      from wallet_ledger_entries
      group by wallet_id
    ) s on s.wallet_id = w.id
    where w.balance_amount <> coalesce(s.rebuilt, 0)`;
  for (const row of drifted) {
    violations.push({
      walletId: row.id,
      message: `balance ${row.stored} differs from the ledger ${row.rebuilt}`,
    });
  }
  const breaks = await sql`
    select wallet_id, wallet_version from (
      select wallet_id, wallet_version, balance_before,
        lag(balance_after) over (partition by wallet_id order by wallet_version) as previous_after,
        lag(wallet_version) over (partition by wallet_id order by wallet_version) as previous_version
      from wallet_ledger_entries
    ) chain
    where (previous_version is null and balance_before <> 0)
       or (previous_version is not null and (balance_before <> previous_after or wallet_version <> previous_version + 1))`;
  for (const row of breaks) {
    violations.push({
      walletId: row.wallet_id,
      message: `ledger chain breaks at wallet version ${row.wallet_version}`,
    });
  }
  const versions = await sql`
    select w.id, w.version, v.last_entry
    from wallets w
    left join (
      select wallet_id, max(wallet_version) as last_entry, min(wallet_version) as first_entry
      from wallet_ledger_entries
      group by wallet_id
    ) v on v.wallet_id = w.id
    where w.version <> coalesce(v.last_entry, 1) or v.first_entry > 2`;
  for (const row of versions) {
    violations.push({
      walletId: row.id,
      message: `wallet version ${row.version} does not match its ledger (last entry ${row.last_entry})`,
    });
  }
  const entries = await sql`
    select t.wallet_id, t.id, t.kind, t.status, count(l.id)::int as entries
    from wager_transactions t
    left join wallet_ledger_entries l on l.transaction_id = t.id
    group by t.id
    having count(l.id) <> case when t.status = 'PROCESSED' and t.kind <> 'LOSS' then 1 else 0 end`;
  for (const row of entries) {
    const expected = row.status === 'PROCESSED' && row.kind !== 'LOSS' ? 1 : 0;
    violations.push({
      walletId: row.wallet_id,
      message: `${row.status} ${row.kind} ${row.id} has ${row.entries} ledger entries instead of ${expected}`,
    });
  }
  const reversals = await sql`
    select wallet_id, reference_transaction_id, kind, count(*)::int as reversals
    from wager_transactions
    where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK')
    group by wallet_id, reference_transaction_id, kind
    having count(*) > 1`;
  for (const row of reversals) {
    violations.push({
      walletId: row.wallet_id,
      message: `${row.kind} applied ${row.reversals} times to ${row.reference_transaction_id}`,
    });
  }
  return violations;
}

export async function walletInvariantViolations(
  sql: SQL,
  walletId: string,
): Promise<string[]> {
  const [wallet] = await sql`select 1 from wallets where id = ${walletId}`;
  if (wallet === undefined) {
    return [`wallet ${walletId} does not exist`];
  }
  return (await invariantViolations(sql))
    .filter((violation) => violation.walletId === walletId)
    .map((violation) => violation.message);
}

export async function inconsistentWallets(
  sql: SQL,
  except: readonly string[] = [],
): Promise<string[]> {
  return (await invariantViolations(sql))
    .filter((violation) => !except.includes(violation.walletId))
    .map((violation) => `wallet ${violation.walletId}: ${violation.message}`);
}
