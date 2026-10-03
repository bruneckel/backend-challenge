import type { SQL } from 'bun';
import type { Row } from './database';
import { ledgerRow, openingOf, transactionRow, walletRow } from './schema-rows';

export async function storeWallet(sql: SQL, overrides: Row = {}): Promise<Row> {
  const wallet = walletRow(overrides);
  await sql.begin(async (tx) => {
    await tx`insert into wallets ${tx(wallet)}`;
    if (Number(wallet.balance_amount) > 0) {
      const opening = transactionRow(wallet, openingOf(wallet));
      await tx`insert into wager_transactions ${tx(opening)}`;
      await tx`insert into wallet_ledger_entries ${tx(
        ledgerRow(opening, {
          wallet_version: 1,
          direction: 'CREDIT',
          amount: wallet.balance_amount,
          balance_before: '0.00',
          balance_after: wallet.balance_amount,
        }),
      )}`;
    }
  });
  return wallet;
}

export async function storeMovement(
  sql: SQL,
  wallet: Row,
  transaction: Row,
  entryOverrides: Row = {},
): Promise<Row> {
  const entry = ledgerRow(transaction, entryOverrides);
  await sql.begin(async (tx) => {
    await tx`insert into wager_transactions ${tx(transaction)}`;
    await tx`insert into wallet_ledger_entries ${tx(entry)}`;
    await tx`
      update wallets
      set balance_amount = ${entry.balance_after}, version = ${entry.wallet_version}
      where id = ${wallet.id}`;
  });
  return entry;
}

export function bypassingLedgerGuards(
  sql: SQL,
  drift: (tx: SQL) => PromiseLike<unknown>,
): Promise<unknown> {
  return sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await drift(tx);
  });
}
