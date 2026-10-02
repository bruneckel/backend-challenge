import type { SubmitWagerTransactionCommand } from '@wallet/application/use-cases/submit-wager-transaction';
import type { WalletView } from '@wallet/application/views';
import type { SubmittableKind } from '@wallet/domain/transaction/wager-transaction';

export function commandFor(
  wallet: WalletView,
  kind: SubmittableKind,
  amount: string,
  overrides: Partial<SubmitWagerTransactionCommand> = {},
): SubmitWagerTransactionCommand {
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${Bun.randomUUIDv7()}`;
  const idempotencyKey = overrides.idempotencyKey ?? `provider-a:${externalTransactionId}`;
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: wallet.balance.currency },
    correlationId: 'correlation-1',
    causationId: idempotencyKey,
    ...overrides,
  };
}

export function referencing(
  reference: SubmitWagerTransactionCommand,
  kind: SubmittableKind,
  amount = reference.money.amount,
): SubmitWagerTransactionCommand {
  const externalTransactionId = `ext-${Bun.randomUUIDv7()}`;
  const idempotencyKey = `provider-a:${externalTransactionId}`;
  return {
    ...reference,
    externalTransactionId,
    idempotencyKey,
    causationId: idempotencyKey,
    kind,
    money: { amount, currency: reference.money.currency },
    referenceExternalTransactionId: reference.externalTransactionId,
  };
}
