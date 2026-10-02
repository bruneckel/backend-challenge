import { Money } from '@wallet/domain/money/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateWagerTransactionProps,
  type WagerTransactionState,
} from '@wallet/domain/transaction/wager-transaction';
import { Wallet, type WalletState } from '@wallet/domain/wallet/wallet';

export const AT = new Date('2026-10-02T12:00:00.000Z');
export const LATER = new Date('2026-10-02T12:05:00.000Z');
export const HASH = 'a'.repeat(64);

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

export function walletWith(balance: string, overrides: Partial<WalletState> = {}): Wallet {
  return Wallet.rehydrate({
    id: 'wallet-1',
    playerId: 'player-1',
    currency: 'BRL',
    balance: brl(balance),
    version: 1,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

let sequence = 0;

export function transactionProps(
  kind: CreateWagerTransactionProps['kind'],
  money: Money,
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps {
  sequence += 1;
  return {
    id: `tx-${sequence}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${sequence}`,
    idempotencyKey: `provider-a:ext-${sequence}`,
    payloadHash: HASH,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money,
    correlationId: 'correlation-1',
    createdAt: AT,
    ...overrides,
  };
}

export function pendingTransaction(
  kind: CreateWagerTransactionProps['kind'],
  money: Money,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return WagerTransaction.create(transactionProps(kind, money, overrides));
}

export function storedTransaction(
  kind: WagerTransactionKind,
  money: Money,
  overrides: Partial<WagerTransactionState> = {},
): WagerTransaction {
  sequence += 1;
  return WagerTransaction.rehydrate({
    id: `stored-${sequence}`,
    providerId: 'provider-a',
    externalTransactionId: `stored-ext-${sequence}`,
    idempotencyKey: `provider-a:stored-ext-${sequence}`,
    payloadHash: HASH,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money,
    referenceExternalTransactionId: undefined,
    correlationId: 'correlation-0',
    createdAt: AT,
    status: WagerTransactionStatus.Processed,
    referenceTransactionId: undefined,
    failureCode: undefined,
    processedAt: AT,
    resultBalance: brl('100.00'),
    referenceAttempts: 0,
    nextReferenceAttemptAt: undefined,
    updatedAt: AT,
    ...overrides,
  });
}
