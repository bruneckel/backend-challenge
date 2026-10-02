import { IntegrationEvent, type EventContext, type IntegrationEventProps } from '@messaging/domain/integration-event';
import type { LedgerDirection } from '@wallet/domain/ledger/ledger-direction';
import type { WalletLedgerEntry } from '@wallet/domain/ledger/wallet-ledger-entry';
import type { MoneyProps } from '@wallet/domain/money/money';
import type { Wallet } from '@wallet/domain/wallet/wallet';

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  override readonly eventType = 'WalletBalanceChanged';
  override readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }

  static from(wallet: Wallet, entry: WalletLedgerEntry, context: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...context,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }

  override get messageGroupId(): string {
    return this.data.walletId;
  }
}
