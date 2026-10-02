import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { commandFor } from '@test/support/commands';
import { walletInvariantViolations } from '@test/support/invariants';
import { type PersistenceHarness, createPersistenceHarness } from '@test/support/persistence';
import { type Wagering, createWagering, openWalletWith } from '@test/support/wagering';
import { WagerTransactionKind } from '@wallet/domain/transaction/wager-transaction';

let harness: PersistenceHarness;
let wagering: Wagering;

beforeAll(async () => {
  harness = await createPersistenceHarness();
  wagering = createWagering(harness.unitOfWork);
});

afterAll(async () => {
  await harness.close();
});

describe('C1 the same BET sent fifty times in parallel', () => {
  test('debits once and answers every copy with the original result', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    const bet = commandFor(wallet, WagerTransactionKind.Bet, '10.00');

    const results = await Promise.all(Array.from({ length: 50 }, () => wagering.submit.execute(bet)));

    const applied = results.filter((result) => !result.idempotentReplay);
    expect(applied).toHaveLength(1);
    expect(results.map(({ transactionId, status, balance }) => ({ transactionId, status, balance }))).toEqual(
      Array(50).fill({ transactionId: applied[0]!.transactionId, status: 'PROCESSED', balance: { amount: '90.00', currency: 'BRL' } }),
    );
    const [debits] = await harness.database.sql`
      select count(*)::int as count from wallet_ledger_entries where wallet_id = ${wallet.id} and direction = 'DEBIT'`;
    expect(debits.count).toBe(1);
    expect(await walletInvariantViolations(harness.database.sql, wallet.id)).toEqual([]);
  });
});
