import { DomainError } from '@shared/domain/domain-error';
import type { ExponentialBackoff } from '@shared/domain/exponential-backoff';
import type { IntegrationEvent } from './integration-event';

const MAX_ERROR_LENGTH = 500;

export class InvalidOutboxStateError extends DomainError {
  override readonly code = 'INVALID_OUTBOX_STATE';
}

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  messageGroupId: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | undefined;
  lastError: string | undefined;
}

export class OutboxMessage {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly messageGroupId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  private _attempts: number;
  private _nextAttemptAt: Date;
  private _publishedAt: Date | undefined;
  private _lastError: string | undefined;

  private constructor(state: OutboxMessageState) {
    this.id = state.id;
    this.aggregateId = state.aggregateId;
    this.eventType = state.eventType;
    this.eventVersion = state.eventVersion;
    this.messageGroupId = state.messageGroupId;
    this.payload = state.payload;
    this.occurredAt = state.occurredAt;
    this._attempts = state.attempts;
    this._nextAttemptAt = state.nextAttemptAt;
    this._publishedAt = state.publishedAt;
    this._lastError = state.lastError;
  }

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const envelope: Record<string, unknown> = { ...event.toJSON() };
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      eventVersion: event.version,
      messageGroupId: event.messageGroupId,
      payload: Object.freeze(envelope),
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: event.occurredAt,
      publishedAt: undefined,
      lastError: undefined,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state);
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && now.getTime() >= this._nextAttemptAt.getTime();
  }

  markPublished(at: Date): void {
    this.assertPending();
    this._publishedAt = at;
  }

  scheduleRetry(now: Date, backoff: ExponentialBackoff, reason: string): void {
    this.assertPending();
    this._attempts += 1;
    this._nextAttemptAt = backoff.nextAttemptAt(now, this._attempts);
    this._lastError = reason.slice(0, MAX_ERROR_LENGTH);
  }

  toState(): OutboxMessageState {
    return {
      id: this.id,
      aggregateId: this.aggregateId,
      eventType: this.eventType,
      eventVersion: this.eventVersion,
      messageGroupId: this.messageGroupId,
      payload: this.payload,
      occurredAt: this.occurredAt,
      attempts: this._attempts,
      nextAttemptAt: this._nextAttemptAt,
      publishedAt: this._publishedAt,
      lastError: this._lastError,
    };
  }

  private assertPending(): void {
    if (!this.isPending()) {
      throw new InvalidOutboxStateError(`Event ${this.id} was already published`);
    }
  }
}
