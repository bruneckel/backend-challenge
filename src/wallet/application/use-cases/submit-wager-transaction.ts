import { MessageIdConflictError } from '@messaging/application/errors';
import { InboxMessage } from '@messaging/domain/inbox-message';
import type { Clock } from '@shared/application/clock';
import type { IdGenerator } from '@shared/application/id-generator';
import type { Logger } from '@shared/application/logger';
import type { Channel, Metrics } from '@shared/application/metrics';
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
  metrics: Metrics;
  logger: Logger;
}

interface PreparedSubmission {
  transaction: WagerTransaction;
  causationId: string;
}

const MAX_DEADLOCK_RETRIES = 2;
const deadlockBackoff = ExponentialBackoff.create({ baseMs: 20, maxMs: 100 });

const CONFLICT_TYPES: ReadonlyArray<[new (...args: never[]) => Error, string]> =
  [
    [IdempotencyKeyConflictError, 'idempotency_key'],
    [ExternalTransactionConflictError, 'external_transaction'],
    [MessageIdConflictError, 'message_id'],
  ];

export class SubmitWagerTransaction {
  private readonly settler: TransactionSettler;

  constructor(private readonly deps: SubmitWagerTransactionDependencies) {
    this.settler = new TransactionSettler(
      deps.settlement,
      deps.ids,
      deps.metrics,
    );
  }

  async execute(
    command: SubmitWagerTransactionCommand,
  ): Promise<TransactionResult> {
    const prepared = this.prepare(command);
    return this.observe('http', prepared, async () => {
      const result = await this.withRetries(() =>
        this.deps.unitOfWork.run((scope) => this.process(scope, prepared)),
      );
      return { value: result, result };
    });
  }

  async executeDelivery(
    command: SubmitWagerTransactionCommand,
    delivery: InboxMessage,
  ): Promise<DeliveryOutcome> {
    const prepared = this.prepare(command);
    return this.observe('sqs', prepared, async () => {
      const outcome = await this.withRetries(() =>
        this.deps.unitOfWork.run((scope) =>
          this.processDelivery(scope, prepared, delivery),
        ),
      );
      return {
        value: outcome,
        result: outcome.type === 'handled' ? outcome.result : undefined,
      };
    });
  }

  private async processDelivery(
    scope: WageringScope,
    prepared: PreparedSubmission,
    delivery: InboxMessage,
  ): Promise<DeliveryOutcome> {
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
    const wallet = await this.settler.lockWallet(scope, transaction.walletId);
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
          this.deps.metrics.increment('db_transaction_retries_total', {
            sqlstate: '23505',
          });
          continue;
        }
        if (
          error instanceof TransientFailure &&
          error.reason === 'deadlock' &&
          deadlockRetries < MAX_DEADLOCK_RETRIES
        ) {
          deadlockRetries += 1;
          this.deps.metrics.increment('db_transaction_retries_total', {
            sqlstate: '40P01',
          });
          await new Promise((resolve) =>
            setTimeout(resolve, deadlockBackoff.delayFor(deadlockRetries)),
          );
          continue;
        }
        throw error;
      }
    }
  }

  private async observe<T>(
    channel: Channel,
    prepared: PreparedSubmission,
    run: () => Promise<{ value: T; result: TransactionResult | undefined }>,
  ): Promise<T> {
    const { transaction } = prepared;
    const started = performance.now();
    const context = {
      channel,
      transactionId: transaction.id,
      walletId: transaction.walletId,
      providerId: transaction.providerId,
      kind: transaction.kind,
    };
    try {
      const { value, result } = await run();
      const outcome = this.recordOutcome(channel, transaction, result, context);
      this.deps.metrics.observe(
        'wager_processing_duration_seconds',
        (performance.now() - started) / 1000,
        { channel, kind: transaction.kind, outcome },
      );
      return value;
    } catch (error) {
      const conflict = CONFLICT_TYPES.find(([type]) => error instanceof type);
      if (conflict !== undefined) {
        this.deps.metrics.increment('idempotency_conflicts_total', {
          channel,
          type: conflict[1],
        });
        this.deps.logger.warn('wager transaction refused as a conflict', {
          ...context,
          conflict: conflict[1],
        });
      }
      throw error;
    }
  }

  private recordOutcome(
    channel: Channel,
    transaction: WagerTransaction,
    result: TransactionResult | undefined,
    context: Record<string, string>,
  ): string {
    if (result === undefined) {
      this.deps.metrics.increment('inbox_duplicates_total');
      this.deps.logger.info('duplicate delivery acknowledged', context);
      return 'duplicate';
    }
    if (result.idempotentReplay) {
      this.deps.metrics.increment('idempotency_replays_total', { channel });
      this.deps.logger.info('idempotent replay', {
        ...context,
        transactionId: result.transactionId,
        status: result.status,
      });
      return 'replay';
    }
    this.deps.metrics.increment('wager_transactions_total', {
      kind: transaction.kind,
      status: result.status,
      channel,
    });
    this.deps.logger.info('wager transaction settled', {
      ...context,
      status: result.status,
      failureCode: result.failureCode,
    });
    return result.status;
  }
}
