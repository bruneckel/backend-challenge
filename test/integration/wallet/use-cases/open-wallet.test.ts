import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rejectionOf } from '@test/support/async';
import { walletInvariantViolations } from '@test/support/invariants';
import { type PersistenceHarness, createPersistenceHarness } from '@test/support/persistence';
import { START, type Wagering, createWagering } from '@test/support/wagering';
import { WalletAlreadyExistsError } from '@wallet/application/ports/wallet-repository';
import { InvalidMoneyError } from '@wallet/domain/money/money';

let harness: PersistenceHarness;
let wagering: Wagering;

beforeAll(async () => {
  harness = await createPersistenceHarness();
  wagering = createWagering(harness.unitOfWork);
});

afterAll(async () => {
  await harness.close();
});

const open = (amount: string, playerId: string = Bun.randomUUIDv7(), currency = 'BRL') =>
  wagering.openWallet.execute({ playerId, initialBalance: { amount, currency }, correlationId: 'correlation-1' });

describe('OpenWallet', () => {
  test('opens a wallet with a positive balance together with its OPENING credit and events', async () => {
    const wallet = await open('1000.00');

    expect(wallet).toEqual({
      id: expect.any(String),
      playerId: wallet.playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
      createdAt: START,
      updatedAt: START,
    });
    const transactions = await harness.database.sql`
      select kind, status, provider_id, amount::text as amount from wager_transactions where wallet_id = ${wallet.id}`;
    expect(transactions).toEqual([{ kind: 'OPENING', status: 'PROCESSED', provider_id: 'internal', amount: '1000.00' }]);
    const entries = await harness.database.sql`
      select direction, wallet_version, amount::text as amount, balance_before::text as balance_before
      from wallet_ledger_entries where wallet_id = ${wallet.id}`;
    expect(entries).toEqual([{ direction: 'CREDIT', wallet_version: 1, amount: '1000.00', balance_before: '0.00' }]);
    const events = await harness.database.sql`
      select event_type, message_group_id, payload from outbox_messages where message_group_id = ${wallet.id} order by id`;
    expect(events.map((event: { event_type: string }) => event.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(events[1].payload.data).toMatchObject({ walletVersion: 1, balanceAfter: { amount: '1000.00', currency: 'BRL' } });
    expect(await walletInvariantViolations(harness.database.sql, wallet.id)).toEqual([]);
  });

  test('opens a wallet with a zero balance without OPENING, ledger entries or events', async () => {
    const wallet = await open('0.00');

    expect(wallet.balance).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
    const [counts] = await harness.database.sql`
      select (select count(*)::int from wager_transactions where wallet_id = ${wallet.id}) as transactions,
        (select count(*)::int from wallet_ledger_entries where wallet_id = ${wallet.id}) as entries,
        (select count(*)::int from outbox_messages where message_group_id = ${wallet.id}) as events`;
    expect(counts).toEqual({ transactions: 0, entries: 0, events: 0 });
    expect(await walletInvariantViolations(harness.database.sql, wallet.id)).toEqual([]);
  });

  test('refuses a second wallet for the same player and currency', async () => {
    const first = await open('10.00');

    const failure = await rejectionOf(open('20.00', first.playerId));

    expect(failure).toBeInstanceOf(WalletAlreadyExistsError);
    const [{ count }] = await harness.database.sql`select count(*)::int as count from wallets where player_id = ${first.playerId}`;
    expect(count).toBe(1);
  });

  test('lets the same player open a wallet in another currency', async () => {
    const first = await open('10.00');

    const second = await open('5.00', first.playerId, 'USD');

    expect(second.balance).toEqual({ amount: '5.00', currency: 'USD' });
  });

  test('rejects an initial balance that is not valid money before touching the database', async () => {
    expect(await rejectionOf(open('10.5'))).toBeInstanceOf(InvalidMoneyError);
  });
});
