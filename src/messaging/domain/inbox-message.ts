import { DomainError } from '@shared/domain/domain-error';

export class InvalidInboxMessageError extends DomainError {
  override readonly code = 'INVALID_INBOX_MESSAGE';
}

export class InvalidInboxStateError extends DomainError {
  override readonly code = 'INVALID_INBOX_STATE';
}

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt: Date | undefined;
}

export class InboxMessage {
  private constructor(
    readonly messageId: string,
    readonly consumerName: string,
    readonly payloadHash: string,
    readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    if (props.messageId.length === 0 || props.consumerName.length === 0) {
      throw new InvalidInboxMessageError('Inbox messages need a message id and a consumer name');
    }
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt, undefined);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.messageId, state.consumerName, state.payloadHash, state.receivedAt, state.processedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvalidInboxStateError(`Message ${this.messageId} was already processed`);
    }
    this._processedAt = at;
  }

  matches(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  toState(): InboxMessageState {
    return {
      messageId: this.messageId,
      consumerName: this.consumerName,
      payloadHash: this.payloadHash,
      receivedAt: this.receivedAt,
      processedAt: this._processedAt,
    };
  }
}
