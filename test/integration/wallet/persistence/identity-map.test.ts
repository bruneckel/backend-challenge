import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { EntityManager } from '@mikro-orm/postgresql';
import { InboxMessage } from '@messaging/domain/inbox-message';
import { MikroOrmUnitOfWork } from '@platform/database/mikro-orm-unit-of-work';
import { AT, HASH, openedWallet, settledBet, storeOpenedWallet } from '@test/support/domain-builders';
import { type PersistenceHarness, createPersistenceHarness } from '@test/support/persistence';
import type { WageringScope } from '@wallet/application/ports/wagering-scope';
import { WagerTransactionKind } from '@wallet/domain/transaction/wager-transaction';
import { createWageringScope } from '@wallet/infrastructure/persistence/wagering-scope';

let harness: PersistenceHarness;

beforeAll(async () => {
  harness = await createPersistenceHarness();
});

afterAll(async () => {
  await harness.close();
});

describe('repositories and the identity map', () => {
  test('read rows without leaving managed entities behind for an implicit flush', async () => {
    const opened = openedWallet('100.00');
    const { bet, entry } = settledBet(opened.wallet);
    const message = InboxMessage.receive({ messageId: Bun.randomUUIDv7(), consumerName: 'wager-commands', payloadHash: HASH, receivedAt: AT });
    await harness.unitOfWork.run(async (scope) => {
      await storeOpenedWallet(scope, opened);
      await scope.transactions.insert(bet);
      await scope.ledger.append(entry);
      await scope.inbox.record(message);
    });
    const unitOfWork = new MikroOrmUnitOfWork<WageringScope & { em: EntityManager }>(
      harness.orm,
      (em) => ({ ...createWageringScope(em), em }),
      { lockTimeoutMs: 2000 },
    );

    const managed = await unitOfWork.run(async ({ em, wallets, transactions, ledger, inbox, outbox }) => {
      await wallets.findById(opened.wallet.id);
      await wallets.lockForUpdate(opened.wallet.id);
      await transactions.findById(bet.id);
      await transactions.findByIdempotencyKey(bet.idempotencyKey);
      await transactions.findByExternalId(bet.providerId, bet.externalTransactionId);
      await transactions.lockById(bet.id);
      await transactions.hasProcessedReversal(bet.id, WagerTransactionKind.Refund);
      await ledger.page(opened.wallet.id, { limit: 10 });
      await inbox.record(message);
      await outbox.claimDueBatch(AT, 10);
      return em.getUnitOfWork().getIdentityMap().keys();
    });

    expect(managed).toEqual([]);
  });
});
