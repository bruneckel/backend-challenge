import type { SQL } from 'bun';

export async function walletInvariantViolations(
  sql: SQL,
  walletId: string,
): Promise<string[]> {
  const violations: string[] = [];
  const [balance] = await sql`
    select w.balance_amount::text as stored,
      (coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0))::text as rebuilt,
      w.balance_amount = coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0) as balanced
    from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
    where w.id = ${walletId}
    group by w.id`;
  if (balance === undefined) {
    return [`wallet ${walletId} does not exist`];
  }
  if (balance.balanced !== true) {
    violations.push(
      `balance ${balance.stored} differs from the ledger ${balance.rebuilt}`,
    );
  }
  const breaks = await sql`
    select wallet_version from (
      select wallet_version, balance_before,
        lag(balance_after) over (order by wallet_version) as previous_after,
        lag(wallet_version) over (order by wallet_version) as previous_version
      from wallet_ledger_entries where wallet_id = ${walletId}
    ) chain
    where (previous_version is null and balance_before <> 0)
       or (previous_version is not null and (balance_before <> previous_after or wallet_version <> previous_version + 1))`;
  for (const row of breaks) {
    violations.push(
      `ledger chain breaks at wallet version ${row.wallet_version}`,
    );
  }
  const [versions] = await sql`
    select w.version, max(l.wallet_version) as last_entry, min(l.wallet_version) as first_entry
    from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
    where w.id = ${walletId}
    group by w.id`;
  const expectedVersion = versions.last_entry ?? 1;
  if (
    versions.version !== expectedVersion ||
    (versions.first_entry !== null && versions.first_entry > 2)
  ) {
    violations.push(
      `wallet version ${versions.version} does not match its ledger (last entry ${versions.last_entry})`,
    );
  }
  const entriesPerTransaction = await sql`
    select t.id, t.kind, t.status, count(l.id)::int as entries
    from wager_transactions t left join wallet_ledger_entries l on l.transaction_id = t.id
    where t.wallet_id = ${walletId}
    group by t.id`;
  for (const row of entriesPerTransaction) {
    const expected = row.status === 'PROCESSED' && row.kind !== 'LOSS' ? 1 : 0;
    if (row.entries !== expected) {
      violations.push(
        `${row.status} ${row.kind} ${row.id} has ${row.entries} ledger entries instead of ${expected}`,
      );
    }
  }
  const duplicatedReversals = await sql`
    select reference_transaction_id, kind, count(*)::int as reversals
    from wager_transactions
    where wallet_id = ${walletId} and status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK')
    group by reference_transaction_id, kind
    having count(*) > 1`;
  for (const row of duplicatedReversals) {
    violations.push(
      `${row.kind} applied ${row.reversals} times to ${row.reference_transaction_id}`,
    );
  }
  return violations;
}
