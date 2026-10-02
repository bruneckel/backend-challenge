import type { Clock } from '@shared/application/clock';
import type { IdGenerator } from '@shared/application/id-generator';
import type { PayloadFingerprinter } from '@shared/application/payload-fingerprinter';
import type { UnitOfWork } from '@shared/application/unit-of-work';
import { WalletAlreadyExistsError } from '@wallet/application/ports/wallet-repository';
import type { WageringScope } from '@wallet/application/ports/wagering-scope';
import { settlementEvents } from '@wallet/application/settlement-events';
import { type WalletView, toWalletView } from '@wallet/application/views';
import { Money, type MoneyProps } from '@wallet/domain/money/money';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '@wallet/domain/transaction/wager-transaction';
import { Wallet } from '@wallet/domain/wallet/wallet';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface OpenWalletDependencies {
  unitOfWork: UnitOfWork<WageringScope>;
  fingerprinter: PayloadFingerprinter;
  clock: Clock;
  ids: IdGenerator;
}

export class OpenWallet {
  constructor(private readonly deps: OpenWalletDependencies) {}

  async execute(command: OpenWalletCommand): Promise<WalletView> {
    const initialBalance = Money.from(command.initialBalance);
    const at = this.deps.clock.now();
    const walletId = this.deps.ids.next();
    const openingTransactionId = this.deps.ids.next();
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: command.playerId,
      initialBalance,
      openingTransactionId,
      openingEntryId: this.deps.ids.next(),
      at,
    });
    try {
      await this.deps.unitOfWork.run(async (scope) => {
        await scope.wallets.insert(wallet);
        if (openingEntry === null) {
          return;
        }
        const opening = WagerTransaction.opening({
          id: openingTransactionId,
          walletId,
          playerId: command.playerId,
          money: initialBalance,
          payloadHash: this.deps.fingerprinter.fingerprint({
            kind: WagerTransactionKind.Opening,
            walletId,
            playerId: command.playerId,
            money: initialBalance.toJSON(),
          }),
          correlationId: command.correlationId,
          createdAt: at,
        });
        opening.markProcessed(undefined, wallet.balance, at);
        await scope.transactions.insert(opening);
        await scope.ledger.append(openingEntry);
        await scope.outbox.enqueue(
          settlementEvents(
            this.deps.ids,
            { correlationId: command.correlationId, occurredAt: at },
            {
              transaction: opening,
              wallet,
              outcome: { type: 'processed', ledgerEntry: openingEntry },
            },
          ),
        );
      });
    } catch (error) {
      if (error instanceof WalletAlreadyExistsError) {
        throw await this.withExistingWallet(error);
      }
      throw error;
    }
    return toWalletView(wallet);
  }

  private async withExistingWallet(
    error: WalletAlreadyExistsError,
  ): Promise<WalletAlreadyExistsError> {
    const existing = await this.deps.unitOfWork.run(({ wallets }) =>
      wallets.findByOwner(error.playerId, error.currency),
    );
    return new WalletAlreadyExistsError(error.playerId, error.currency, {
      walletId: existing?.id,
      cause: error,
    });
  }
}
