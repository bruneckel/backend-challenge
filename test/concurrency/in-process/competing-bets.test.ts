import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { commandFor } from '@test/support/commands';
import { walletInvariantViolations } from '@test/support/invariants';
import { type PersistenceHarness, createPersistenceHarness } from '@test/support/persistence';
import { type Wagering, createWagering, openWalletWith } from '@test/support/wagering';
import type { TransactionResult } from '@wallet/application/transaction-result';
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

describe('C2 two 80.00 BETs against a 100.00 balance', () => {
  test.each(Array.from({ length: 25 }, (_, round) => round + 1))('lets exactly one win, even with resends (round %i)', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    const first = commandFor(wallet, WagerTransactionKind.Bet, '80.00');
    const second = commandFor(wallet, WagerTransactionKind.Bet, '80.00');

    const results = await Promise.all([first, second, first, second].map((bet) => wagering.submit.execute(bet)));

    const original = (index: number) => results.filter((result) => result.transactionId === results[index]!.transactionId);
    const outcomes = [original(0), original(1)].map((copies: TransactionResult[]) => {
      expect(copies).toHaveLength(2);
      expect(copies.filter((copy) => !copy.idempotentReplay)).toHaveLength(1);
      expect({ ...copies[0], idempotentReplay: false }).toEqual({ ...copies[1], idempotentReplay: false });
      return copies[0]!;
    });
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    const processed = outcomes.find((outcome) => outcome.status === 'PROCESSED')!;
    const rejected = outcomes.find((outcome) => outcome.status === 'REJECTED')!;
    expect(processed.balance).toEqual({ amount: '20.00', currency: 'BRL' });
    expect(rejected).toMatchObject({ failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '20.00', currency: 'BRL' } });
    const [state] = await harness.database.sql`
      select w.balance_amount::text as balance,
        (select count(*)::int from wallet_ledger_entries l where l.wallet_id = w.id and l.direction = 'DEBIT') as debits
      from wallets w where w.id = ${wallet.id}`;
    expect(state).toEqual({ balance: '20.00', debits: 1 });
    expect(await walletInvariantViolations(harness.database.sql, wallet.id)).toEqual([]);
  });
});
