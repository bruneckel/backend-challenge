import { DomainError } from '@shared/domain/domain-error';
import { LedgerDirection } from '@wallet/domain/ledger/ledger-direction';
import type { Money } from '@wallet/domain/money/money';
import type { FailureCode } from './failure-code';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export type InvalidWagerTransactionCode =
  | 'UNSUPPORTED_KIND'
  | 'REFERENCE_REQUIRED'
  | 'REFERENCE_NOT_ALLOWED'
  | 'INVALID_AMOUNT'
  | 'NO_BALANCE_EFFECT'
  | 'REFERENCE_UNKNOWN';

export class InvalidWagerTransactionError extends DomainError {
  constructor(
    override readonly code: InvalidWagerTransactionCode,
    message: string,
  ) {
    super(message);
  }
}

export class InvalidTransactionStateError extends DomainError {
  override readonly code = 'INVALID_TRANSACTION_STATE';
}

export type SubmittableKind = Exclude<
  WagerTransactionKind,
  WagerTransactionKind.Opening
>;

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: SubmittableKind;
  money: Money;
  referenceExternalTransactionId?: string;
  correlationId: string;
  createdAt: Date;
}

export interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  payloadHash: string;
  correlationId: string;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  correlationId: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  processedAt: Date | undefined;
  resultBalance: Money | undefined;
  referenceAttempts: number;
  nextReferenceAttemptAt: Date | undefined;
  updatedAt: Date;
}

export const INTERNAL_PROVIDER_ID = 'internal';

const TERMINAL_STATUSES: readonly WagerTransactionStatus[] = [
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
];

export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly correlationId: string;
  readonly createdAt: Date;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAt: Date | undefined;
  private _resultBalance: Money | undefined;
  private _referenceAttempts: number;
  private _nextReferenceAttemptAt: Date | undefined;
  private _updatedAt: Date;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.correlationId = state.correlationId;
    this.createdAt = state.createdAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt;
    this._resultBalance = state.resultBalance;
    this._referenceAttempts = state.referenceAttempts;
    this._nextReferenceAttemptAt = state.nextReferenceAttemptAt;
    this._updatedAt = state.updatedAt;
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const kind = props.kind as WagerTransactionKind;
    if (kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError(
        'UNSUPPORTED_KIND',
        'OPENING is internal and cannot be submitted',
      );
    }
    const hasReference = props.referenceExternalTransactionId !== undefined;
    if (
      (kind === WagerTransactionKind.Refund ||
        kind === WagerTransactionKind.Rollback) &&
      !hasReference
    ) {
      throw new InvalidWagerTransactionError(
        'REFERENCE_REQUIRED',
        `${kind} requires a reference`,
      );
    }
    if (kind === WagerTransactionKind.Bet && hasReference) {
      throw new InvalidWagerTransactionError(
        'REFERENCE_NOT_ALLOWED',
        'BET cannot reference another transaction',
      );
    }
    if (kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new InvalidWagerTransactionError(
        'INVALID_AMOUNT',
        `${kind} requires a positive amount`,
      );
    }
    return WagerTransaction.pending({
      ...props,
      referenceExternalTransactionId: props.referenceExternalTransactionId,
    });
  }

  static opening(props: OpeningTransactionProps): WagerTransaction {
    const reference = `opening:${props.walletId}`;
    return WagerTransaction.pending({
      id: props.id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: reference,
      idempotencyKey: reference,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: INTERNAL_PROVIDER_ID,
      kind: WagerTransactionKind.Opening,
      money: props.money,
      referenceExternalTransactionId: undefined,
      correlationId: props.correlationId,
      createdAt: props.createdAt,
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  private static pending(
    props: Omit<
      CreateWagerTransactionProps,
      'kind' | 'referenceExternalTransactionId'
    > & {
      kind: WagerTransactionKind;
      referenceExternalTransactionId: string | undefined;
    },
  ): WagerTransaction {
    return new WagerTransaction({
      ...props,
      status: WagerTransactionStatus.Pending,
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: undefined,
      resultBalance: undefined,
      referenceAttempts: 0,
      nextReferenceAttemptAt: undefined,
      updatedAt: props.createdAt,
    });
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  markProcessed(
    referenceTransactionId: string | undefined,
    resultBalance: Money,
    at: Date,
  ): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._resultBalance = resultBalance;
    this._nextReferenceAttemptAt = undefined;
    this._updatedAt = at;
  }

  markPendingReference(
    observedBalance: Money,
    nextAttemptAt: Date,
    at: Date,
  ): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(
        `Transaction ${this.id} is ${this._status} and cannot start waiting`,
      );
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._resultBalance = observedBalance;
    this._nextReferenceAttemptAt = nextAttemptAt;
    this._updatedAt = at;
  }

  scheduleReferenceRetry(nextAttemptAt: Date, at: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(
        `Transaction ${this.id} is ${this._status} and is not waiting`,
      );
    }
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = nextAttemptAt;
    this._updatedAt = at;
  }

  reject(code: FailureCode, observedBalance: Money, at: Date): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._resultBalance = observedBalance;
    this._nextReferenceAttemptAt = undefined;
    this._updatedAt = at;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextReferenceAttemptAt = undefined;
    this._updatedAt = at;
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.includes(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError(
          'NO_BALANCE_EFFECT',
          'LOSS does not move the balance',
        );
      case WagerTransactionKind.Rollback:
        if (reference === undefined) {
          throw new InvalidWagerTransactionError(
            'REFERENCE_UNKNOWN',
            'ROLLBACK needs its reference to know the direction',
          );
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
    }
  }

  toState(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money,
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      correlationId: this.correlationId,
      createdAt: this.createdAt,
      status: this._status,
      referenceTransactionId: this._referenceTransactionId,
      failureCode: this._failureCode,
      processedAt: this._processedAt,
      resultBalance: this._resultBalance,
      referenceAttempts: this._referenceAttempts,
      nextReferenceAttemptAt: this._nextReferenceAttemptAt,
      updatedAt: this._updatedAt,
    };
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `Transaction ${this.id} is ${this._status} and cannot change`,
      );
    }
  }
}
