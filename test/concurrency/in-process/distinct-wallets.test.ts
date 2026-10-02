import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { TransientFailure } from '@shared/application/transient-failure';
import { rejectionOf } from '@test/support/async';
import { commandFor } from '@test/support/commands';
import { walletInvariantViolations } from '@test/support/invariants';
import {
  type PersistenceHarness,
  createPersistenceHarness,
} from '@test/support/persistence';
import {
  type Wagering,
  createWagering,
  openWalletWith,
} from '@test/support/wagering';
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

describe('C3 distinct wallets', () => {
  test('are processed in parallel without interfering with each other', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 10 }, () => openWalletWith(wagering, '100.00')),
    );

    const results = await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: 5 }, () =>
          wagering.submit.execute(
            commandFor(wallet, WagerTransactionKind.Bet, '10.00'),
          ),
        ),
      ),
    );

    expect(results.every((result) => result.status === 'PROCESSED')).toBe(true);
    for (const wallet of wallets) {
      expect(await wagering.queries.getWallet(wallet.id)).toMatchObject({
        balance: { amount: '50.00' },
        version: 6,
      });
      expect(
        await walletInvariantViolations(harness.database.sql, wallet.id),
      ).toEqual([]);
    }
  });

  test('are not blocked by a lock held on another wallet', async () => {
    const held = await openWalletWith(wagering, '100.00');
    const free = await openWalletWith(wagering, '100.00');
    const holder = await harness.database.sql.reserve();
    await holder`begin`;
    await holder`select id from wallets where id = ${held.id} for update`;

    try {
      const freeResult = await wagering.submit.execute(
        commandFor(free, WagerTransactionKind.Bet, '10.00'),
      );
      const heldFailure = await rejectionOf(
        wagering.submit.execute(
          commandFor(held, WagerTransactionKind.Bet, '10.00'),
        ),
      );

      expect(freeResult.status).toBe('PROCESSED');
      expect(heldFailure).toBeInstanceOf(TransientFailure);
      expect(heldFailure).toMatchObject({ reason: 'lock_timeout' });
    } finally {
      await holder`rollback`;
      holder.release();
    }
  });
});
