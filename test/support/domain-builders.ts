import type { WageringScope } from '@wallet/application/ports/wagering-scope';
import type { WalletLedgerEntry } from '@wallet/domain/ledger/wallet-ledger-entry';
import { Money } from '@wallet/domain/money/money';
import {
  type CreateWagerTransactionProps,
  type SubmittableKind,
  WagerTransaction,
  WagerTransactionKind,
} from '@wallet/domain/transaction/wager-transaction';
import { Wallet } from '@wallet/domain/wallet/wallet';

export const AT = new Date('2026-10-02T12:00:00.000Z');
export const LATER = new Date('2026-10-02T12:05:00.000Z');
export const HASH = 'a'.repeat(64);

export const money = (amount: string, currency = 'BRL') => Money.from({ amount, currency });

export interface OpenedWallet {
  wallet: Wallet;
  opening: WagerTransaction | null;
  openingEntry: WalletLedgerEntry | null;
}

export function openedWallet(initialBalance = '100.00', currency = 'BRL'): OpenedWallet {
  const id = Bun.randomUUIDv7();
  const playerId = Bun.randomUUIDv7();
  const openingTransactionId = Bun.randomUUIDv7();
  const initial = money(initialBalance, currency);
  const { wallet, openingEntry } = Wallet.open({
    id,
    playerId,
    initialBalance: initial,
    openingTransactionId,
    openingEntryId: Bun.randomUUIDv7(),
    at: AT,
  });
  if (openingEntry === null) {
    return { wallet, opening: null, openingEntry };
  }
  const opening = WagerTransaction.opening({
    id: openingTransactionId,
    walletId: id,
    playerId,
    money: initial,
    payloadHash: HASH,
    correlationId: 'correlation-1',
    createdAt: AT,
  });
  opening.markProcessed(undefined, wallet.balance, AT);
  return { wallet, opening, openingEntry };
}

export async function storeOpenedWallet(scope: WageringScope, opened: OpenedWallet): Promise<void> {
  await scope.wallets.insert(opened.wallet);
  if (opened.opening !== null && opened.openingEntry !== null) {
    await scope.transactions.insert(opened.opening);
    await scope.ledger.append(opened.openingEntry);
  }
}

export function pendingTransaction(
  wallet: Wallet,
  kind: SubmittableKind,
  amount: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const externalTransactionId = `ext-${Bun.randomUUIDv7()}`;
  return WagerTransaction.create({
    id: Bun.randomUUIDv7(),
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: HASH,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: money(amount, wallet.currency),
    correlationId: 'correlation-1',
    createdAt: AT,
    ...overrides,
  });
}

export function settledBet(wallet: Wallet, amount = '10.00'): { bet: WagerTransaction; entry: WalletLedgerEntry } {
  const bet = pendingTransaction(wallet, WagerTransactionKind.Bet, amount);
  const entry = wallet.debit(bet.money, { transactionId: bet.id, entryId: Bun.randomUUIDv7(), at: AT });
  bet.markProcessed(undefined, wallet.balance, AT);
  return { bet, entry };
}
