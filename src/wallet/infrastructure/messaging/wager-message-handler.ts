import { inboxMessagePayload } from '@messaging/application/inbound-message';
import { InboxMessage } from '@messaging/domain/inbox-message';
import type {
  ConsumedMessage,
  Disposition,
} from '@messaging/infrastructure/sqs/message-batch-consumer';
import type { Clock } from '@shared/application/clock';
import type { PayloadFingerprinter } from '@shared/application/payload-fingerprinter';
import type { ExponentialBackoff } from '@shared/domain/exponential-backoff';
import type {
  SubmitWagerTransaction,
  SubmitWagerTransactionCommand,
} from '@wallet/application/use-cases/submit-wager-transaction';
import type { SubmittableKind } from '@wallet/domain/transaction/wager-transaction';
import {
  type WagerTransactionRequested,
  wagerTransactionRequestedSchema,
} from '@wallet/infrastructure/contracts/wager-operation.schema';
import { classifyConsumerFailure } from './consumer-failures';

export interface WagerMessageHandlerDependencies {
  submit: SubmitWagerTransaction;
  fingerprinter: PayloadFingerprinter;
  clock: Clock;
  consumerName: string;
  maxAttempts: number;
  retryBackoff: ExponentialBackoff;
}

export class WagerMessageHandler {
  constructor(private readonly deps: WagerMessageHandlerDependencies) {}

  readonly handle = async (message: ConsumedMessage): Promise<Disposition> => {
    const request = parseRequest(message.body);
    if (request === undefined) {
      return { action: 'dead_letter', reason: 'INVALID_MESSAGE' };
    }
    try {
      await this.deps.submit.executeDelivery(
        commandFrom(request),
        InboxMessage.receive({
          messageId: request.messageId,
          consumerName: this.deps.consumerName,
          payloadHash: this.deps.fingerprinter.fingerprint(
            inboxMessagePayload(request),
          ),
          receivedAt: this.deps.clock.now(),
        }),
      );
      return { action: 'acknowledge' };
    } catch (error) {
      const failure = classifyConsumerFailure(error);
      if (failure.type === 'dead_letter') {
        return {
          action: 'dead_letter',
          reason: failure.reason,
          originalMessageId: request.messageId,
        };
      }
      if (message.receiveCount >= this.deps.maxAttempts) {
        return {
          action: 'dead_letter',
          reason: 'RETRIES_EXHAUSTED',
          originalMessageId: request.messageId,
        };
      }
      return {
        action: 'retry',
        delaySeconds: Math.ceil(
          this.deps.retryBackoff.delayFor(message.receiveCount) / 1000,
        ),
        pauseConsumer: failure.pauseConsumer,
      };
    }
  };
}

function parseRequest(body: string): WagerTransactionRequested | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    return undefined;
  }
  const parsed = wagerTransactionRequestedSchema.safeParse(decoded);
  return parsed.success ? parsed.data : undefined;
}

function commandFrom(
  request: WagerTransactionRequested,
): SubmitWagerTransactionCommand {
  const { idempotencyKey, ...operation } = request.data;
  return {
    ...operation,
    kind: operation.kind as SubmittableKind,
    idempotencyKey,
    correlationId: request.messageId,
    causationId: request.messageId,
  };
}
