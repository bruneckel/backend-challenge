import type { MoneyProps } from '@wallet/domain/money/money';

export interface WagerOperation {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export function wagerOperationPayload(
  operation: WagerOperation,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    providerId: operation.providerId,
    externalTransactionId: operation.externalTransactionId,
    playerId: operation.playerId,
    walletId: operation.walletId,
    roundId: operation.roundId,
    gameId: operation.gameId,
    kind: operation.kind,
    money: {
      amount: operation.money.amount,
      currency: operation.money.currency,
    },
  };
  if (operation.referenceExternalTransactionId !== undefined) {
    payload.referenceExternalTransactionId =
      operation.referenceExternalTransactionId;
  }
  return payload;
}
