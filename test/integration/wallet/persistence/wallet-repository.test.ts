import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  AT,
  LATER,
  money,
  openedWallet,
  storeOpenedWallet,
} from '@test/support/domain-builders';
import { gate, rejectionOf } from '@test/support/async';
import {
  type PersistenceHarness,
  createPersistenceHarness,
  plain,
} from '@test/support/persistence';
import {
  StaleWalletVersionError,
  WalletAlreadyExistsError,
} from '@wallet/application/ports/wallet-repository';
import { Wallet } from '@wallet/domain/wallet/wallet';

let harness: PersistenceHarness;

beforeAll(async () => {
  harness = await createPersistenceHarness();
});

afterAll(async () => {
  await harness.close();
});

async function stored(initialBalance = '100.00'): Promise<Wallet> {
  const opened = openedWallet(initialBalance);
  await harness.unitOfWork.run((scope) => storeOpenedWallet(scope, opened));
  return opened.wallet;
}

const movement = () => ({
  transactionId: Bun.randomUUIDv7(),
  entryId: Bun.randomUUIDv7(),
  at: LATER,
});

describe('MikroOrmWalletRepository', () => {
  test.each(['99999999999999999.99', '0.00', '0.10'])(
    'round-trips a wallet with a balance of %s',
    async (balance) => {
      const wallet = await stored(balance);

      const found = await harness.unitOfWork.run(({ wallets }) =>
        wallets.findById(wallet.id),
      );

      expect(plain(found?.toState())).toEqual(plain(wallet.toState()));
      expect(found?.balance.toJSON()).toEqual({
        amount: balance,
        currency: 'BRL',
      });
    },
  );

  test('returns null for an unknown wallet', async () => {
    const unknown = Bun.randomUUIDv7();

    expect(
      await harness.unitOfWork.run(({ wallets }) => wallets.findById(unknown)),
    ).toBeNull();
    expect(
      await harness.unitOfWork.run(({ wallets }) =>
        wallets.lockForUpdate(unknown),
      ),
    ).toBeNull();
  });

  test('refuses a second wallet for the same player and currency', async () => {
    const wallet = await stored();
    const duplicate = Wallet.open({
      id: Bun.randomUUIDv7(),
      playerId: wallet.playerId,
      initialBalance: money('0.00'),
      openingTransactionId: Bun.randomUUIDv7(),
      openingEntryId: Bun.randomUUIDv7(),
      at: AT,
    }).wallet;

    const insert = harness.unitOfWork.run(({ wallets }) =>
      wallets.insert(duplicate),
    );

    expect(await rejectionOf(insert)).toBeInstanceOf(WalletAlreadyExistsError);
  });

  test('applies a balance change when the stored version still matches', async () => {
    const wallet = await stored('100.00');

    await harness.unitOfWork.run(async ({ wallets }) => {
      const locked = await wallets.lockForUpdate(wallet.id);
      const expectedVersion = locked!.version;
      locked!.debit(money('30.00'), movement());
      await wallets.applyBalanceChange(locked!, expectedVersion);
    });

    const found = await harness.unitOfWork.run(({ wallets }) =>
      wallets.findById(wallet.id),
    );
    expect(found?.balance.toJSON()).toEqual({
      amount: '70.00',
      currency: 'BRL',
    });
    expect(found?.version).toBe(2);
    expect(found?.updatedAt).toEqual(LATER);
  });

  test('refuses a balance change computed from a stale version', async () => {
    const wallet = await stored('100.00');
    const stale = Wallet.rehydrate(wallet.toState());
    await harness.unitOfWork.run(async ({ wallets }) => {
      const locked = await wallets.lockForUpdate(wallet.id);
      locked!.debit(money('10.00'), movement());
      await wallets.applyBalanceChange(locked!, 1);
    });
    stale.debit(money('50.00'), movement());

    const apply = harness.unitOfWork.run(({ wallets }) =>
      wallets.applyBalanceChange(stale, 1),
    );

    expect(await rejectionOf(apply)).toBeInstanceOf(StaleWalletVersionError);
    const found = await harness.unitOfWork.run(({ wallets }) =>
      wallets.findById(wallet.id),
    );
    expect(found?.balance.toJSON()).toEqual({
      amount: '90.00',
      currency: 'BRL',
    });
  });

  test('makes a second locker wait for the first commit and then read the new balance', async () => {
    const wallet = await stored('100.00');
    const firstLocked = gate();
    const order: string[] = [];

    const first = harness.unitOfWork.run(async ({ wallets }) => {
      const locked = await wallets.lockForUpdate(wallet.id);
      order.push('first locked');
      firstLocked.open();
      await Bun.sleep(200);
      locked!.debit(money('80.00'), movement());
      await wallets.applyBalanceChange(locked!, 1);
      order.push('first committing');
    });
    await firstLocked.opened;
    const second = harness.unitOfWork.run(async ({ wallets }) => {
      order.push('second waiting');
      const locked = await wallets.lockForUpdate(wallet.id);
      order.push('second locked');
      return locked;
    });
    const [, seen] = await Promise.all([first, second]);

    expect(order).toEqual([
      'first locked',
      'second waiting',
      'first committing',
      'second locked',
    ]);
    expect(seen?.balance.toJSON()).toEqual({
      amount: '20.00',
      currency: 'BRL',
    });
    expect(seen?.version).toBe(2);
  });

  test('locks one wallet without blocking another', async () => {
    const held = await stored();
    const free = await stored();
    const heldLocked = gate();
    const release = gate();

    const holder = harness.unitOfWork.run(async ({ wallets }) => {
      await wallets.lockForUpdate(held.id);
      heldLocked.open();
      await release.opened;
    });
    await heldLocked.opened;
    const other = await harness.unitOfWork.run(({ wallets }) =>
      wallets.lockForUpdate(free.id),
    );
    release.open();
    await holder;

    expect(other?.id).toBe(free.id);
  });
});
