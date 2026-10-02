import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { commandFor, referencing } from '@test/support/commands';
import { walletInvariantViolations } from '@test/support/invariants';
import { type PersistenceHarness, createPersistenceHarness } from '@test/support/persistence';
import { type Wagering, createWagering, openWalletWith } from '@test/support/wagering';
import type { TransactionResult } from '@wallet/application/transaction-result';
import { WagerTransactionKind } from '@wallet/domain/transaction/wager-transaction';

let harness: PersistenceHarness;
let wagering: Wagering;
const { Bet, Refund, Rollback } = WagerTransactionKind;

beforeAll(async () => {
  harness = await createPersistenceHarness();
  wagering = createWagering(harness.unitOfWork);
});

afterAll(async () => {
  await harness.close();
});

function byTransaction(results: TransactionResult[]): TransactionResult[] {
  const originals = new Map<string, TransactionResult>();
  for (const result of results) {
    if (!result.idempotentReplay) {
      originals.set(result.transactionId, result);
    }
  }
  return [...originals.values()];
}

async function balanceOf(walletId: string): Promise<string> {
  const [row] = await harness.database.sql`select balance_amount::text as balance from wallets where id = ${walletId}`;
  return row.balance;
}

describe('C9 reversals', () => {
  test.each([Refund, Rollback] as const)('apply only one of several concurrent %s operations on the same BET', async (kind) => {
    const wallet = await openWalletWith(wagering, '100.00');
    const bet = commandFor(wallet, Bet, '40.00');
    await wagering.submit.execute(bet);
    const reversals = Array.from({ length: 5 }, () => referencing(bet, kind));

    const results = await Promise.all([...reversals, ...reversals].map((reversal) => wagering.submit.execute(reversal)));

    const originals = byTransaction(results);
    expect(originals).toHaveLength(5);
    expect(originals.filter((result) => result.status === 'PROCESSED')).toHaveLength(1);
    expect(originals.filter((result) => result.failureCode === 'REFERENCE_ALREADY_REVERSED')).toHaveLength(4);
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect(await walletInvariantViolations(harness.database.sql, wallet.id)).toEqual([]);
  });

  test('accept a REFUND and a ROLLBACK of the same BET and return the stake twice', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    const bet = commandFor(wallet, Bet, '40.00');
    await wagering.submit.execute(bet);

    const results = await Promise.all([referencing(bet, Refund), referencing(bet, Rollback)].map((reversal) => wagering.submit.execute(reversal)));

    expect(results.map((result) => result.status)).toEqual(['PROCESSED', 'PROCESSED']);
    expect(await balanceOf(wallet.id)).toBe('140.00');
    expect(await walletInvariantViolations(harness.database.sql, wallet.id)).toEqual([]);
  });

  test('reject a ROLLBACK of a REFUND that would overdraw the wallet with REVERSAL_INSUFFICIENT_FUNDS', async () => {
    const wallet = await openWalletWith(wagering, '100.00');
    const bet = commandFor(wallet, Bet, '50.00');
    await wagering.submit.execute(bet);
    const refund = referencing(bet, Refund);
    await wagering.submit.execute(refund);
    await wagering.submit.execute(commandFor(wallet, Bet, '100.00'));
    const rollback = referencing(refund, Rollback);

    const results = await Promise.all([rollback, rollback, rollback].map((copy) => wagering.submit.execute(copy)));

    expect(byTransaction(results)).toEqual([
      expect.objectContaining({ status: 'REJECTED', failureCode: 'REVERSAL_INSUFFICIENT_FUNDS', balance: { amount: '0.00', currency: 'BRL' } }),
    ]);
    expect(await balanceOf(wallet.id)).toBe('0.00');
    expect(await walletInvariantViolations(harness.database.sql, wallet.id)).toEqual([]);
  });
});
