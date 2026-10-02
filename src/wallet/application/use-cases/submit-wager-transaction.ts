import { MessageIdConflictError } from '@messaging/application/errors';
import { InboxMessage } from '@messaging/domain/inbox-message';
import type { Clock } from '@shared/application/clock';
import type { IdGenerator } from '@shared/application/id-generator';
import type { PayloadFingerprinter } from '@shared/application/payload-fingerprinter';
import { TransientFailure } from '@shared/application/transient-failure';
import type { UnitOfWork } from '@shared/application/unit-of-work';
import { ExponentialBackoff } from '@shared/domain/exponential-backoff';
import {
  ExternalTransactionConflictError,
  IdempotencyKeyConflictError,
  WalletNotFoundError,
} from '@wallet/application/errors';
import type { WageringScope } from '@wallet/application/ports/wagering-scope';
import { DuplicateWagerTransactionError } from '@wallet/application/ports/wager-transaction-repository';
import {
  type TransactionResult,
  transactionResult,
} from '@wallet/application/transaction-result';
import { TransactionSettler } from '@wallet/application/transaction-settler';
import {
  type WagerOperation,
  wagerOperationPayload,
} from '@wallet/application/wager-operation';
import { Money } from '@wallet/domain/money/money';
import type { SettlementPolicy } from '@wallet/domain/settlement/settlement-policy';
import {
  type SubmittableKind,
  WagerTransaction,
} from '@wallet/domain/transaction/wager-transaction';

export interface SubmitWagerTransactionCommand extends WagerOperation {
  kind: SubmittableKind;
  idempotencyKey: string;
  correlationId: string;
  causationId: string;
}

export type DeliveryOutcome =
  { type: 'handled'; result: TransactionResult } | { type: 'duplicate' };

export interface SubmitWagerTransactionDependencies {
  unitOfWork: UnitOfWork<WageringScope>;
  fingerprinter: PayloadFingerprinter;
  clock: Clock;
  ids: IdGenerator;
  settlement: SettlementPolicy;
}

interface PreparedSubmission {
  transaction: WagerTransaction;
  causationId: string;
}

const MAX_DEADLOCK_RETRIES = 2;
const deadlockBackoff = ExponentialBackoff.create({ baseMs: 20, maxMs: 100 });

export class SubmitWagerTransaction {
  private readonly settler: TransactionSettler;

  constructor(private readonly deps: SubmitWagerTransactionDependencies) {
    this.settler = new TransactionSettler(deps.settlement, deps.ids);
  }

  async execute(
    command: SubmitWagerTransactionCommand,
  ): Promise<TransactionResult> {
    const prepared = this.prepare(command);
    return this.withRetries(() =>
      this.deps.unitOfWork.run((scope) => this.process(scope, prepared)),
    );
  }

  async executeDelivery(
    command: SubmitWagerTransactionCommand,
    delivery: InboxMessage,
  ): Promise<DeliveryOutcome> {
    const prepared = this.prepare(command);
    return this.withRetries(() =>
      this.deps.unitOfWork.run(async (scope): Promise<DeliveryOutcome> => {
        const message = InboxMessage.rehydrate(delivery.toState());
        const recording = await scope.inbox.record(message);
        if (!recording.recorded) {
          if (!recording.existing.matches(message.payloadHash)) {
            throw new MessageIdConflictError(message.messageId);
          }
          return { type: 'duplicate' };
        }
        const result = await this.process(scope, prepared);
        message.markProcessed(this.deps.clock.now());
        await scope.inbox.saveProcessed(message, result.transactionId);
        return { type: 'handled', result };
      }),
    );
  }

  private prepare(command: SubmitWagerTransactionCommand): PreparedSubmission {
    const transaction = WagerTransaction.create({
      id: this.deps.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: this.deps.fingerprinter.fingerprint(
        wagerOperationPayload(command),
      ),
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: Money.from(command.money),
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      correlationId: command.correlationId,
      createdAt: this.deps.clock.now(),
    });
    return { transaction, causationId: command.causationId };
  }

  private async process(
    scope: WageringScope,
    prepared: PreparedSubmission,
  ): Promise<TransactionResult> {
    const transaction = WagerTransaction.rehydrate(
      prepared.transaction.toState(),
    );
    const known = await this.knownResult(scope, transaction);
    if (known !== undefined) {
      return known;
    }
    const wallet = await scope.wallets.lockForUpdate(transaction.walletId);
    if (wallet === null) {
      throw new WalletNotFoundError(transaction.walletId);
    }
    const knownUnderLock = await this.knownResult(scope, transaction);
    if (knownUnderLock !== undefined) {
      return knownUnderLock;
    }
    const sameExternalId = await scope.transactions.findByExternalId(
      transaction.providerId,
      transaction.externalTransactionId,
    );
    if (sameExternalId !== null) {
      throw new ExternalTransactionConflictError(
        transaction.providerId,
        transaction.externalTransactionId,
      );
    }
    const at = this.deps.clock.now();
    const settlement = await this.settler.settle(
      scope,
      transaction,
      wallet,
      at,
    );
    await this.settler.recordNew(scope, settlement, {
      correlationId: transaction.correlationId,
      causationId: prepared.causationId,
      occurredAt: at,
    });
    return transactionResult(transaction, false);
  }

  private async knownResult(
    scope: WageringScope,
    transaction: WagerTransaction,
  ): Promise<TransactionResult | undefined> {
    const existing = await scope.transactions.findByIdempotencyKey(
      transaction.idempotencyKey,
    );
    if (existing === null) {
      return undefined;
    }
    if (!existing.matchesPayload(transaction.payloadHash)) {
      throw new IdempotencyKeyConflictError(transaction.idempotencyKey);
    }
    return transactionResult(existing, true);
  }

  private async withRetries<T>(attempt: () => Promise<T>): Promise<T> {
    let duplicateRetried = false;
    let deadlockRetries = 0;
    for (;;) {
      try {
        return await attempt();
      } catch (error) {
        if (
          error instanceof DuplicateWagerTransactionError &&
          !duplicateRetried
        ) {
          duplicateRetried = true;
          continue;
        }
        if (
          error instanceof TransientFailure &&
          error.reason === 'deadlock' &&
          deadlockRetries < MAX_DEADLOCK_RETRIES
        ) {
          deadlockRetries += 1;
          await new Promise((resolve) =>
            setTimeout(resolve, deadlockBackoff.delayFor(deadlockRetries)),
          );
          continue;
        }
        throw error;
      }
    }
  }
}
