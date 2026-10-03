import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { bearerFor } from '@test/support/identity';
import {
  type LoadWallet,
  type Operation,
  operationFor,
} from '@test/support/load';

export type Outcome =
  | 'ok'
  | 'replay'
  | 'rejected'
  | 'conflict'
  | 'client_error'
  | 'unavailable'
  | 'server_error'
  | 'timeout'
  | 'network_error'
  | 'dropped';

export const SUCCESSFUL: ReadonlySet<Outcome> = new Set([
  'ok',
  'replay',
  'rejected',
]);

export function outcomeOfStatus(status: number, replay: boolean): Outcome {
  if (status === 200 || status === 202) {
    return replay ? 'replay' : 'ok';
  }
  if (status === 422) {
    return 'rejected';
  }
  if (status === 409) {
    return 'conflict';
  }
  if (status === 503) {
    return 'unavailable';
  }
  return status >= 500 ? 'server_error' : 'client_error';
}

export function outcomeOfError(error: unknown): Outcome {
  const name = error instanceof Error ? error.name : '';
  return name === 'TimeoutError' || name === 'AbortError'
    ? 'timeout'
    : 'network_error';
}

const HISTORY = 1000;

export interface OperationFactoryOptions {
  wallets: readonly LoadWallet[];
  hot: LoadWallet;
  hotShare: number;
  replayShare: number;
  random?: () => number;
}

export class OperationFactory {
  private readonly history: Operation[] = [];
  private readonly random: () => number;
  replays = 0;

  constructor(private readonly options: OperationFactoryOptions) {
    this.random = options.random ?? Math.random;
  }

  next(): Operation {
    if (this.options.replayShare > 0 && this.history.length > 0) {
      if (this.random() < this.options.replayShare) {
        this.replays += 1;
        return this.history[Math.floor(this.random() * this.history.length)]!;
      }
    }
    const wallet =
      this.random() < this.options.hotShare
        ? this.options.hot
        : this.options.wallets[
            Math.floor(this.random() * this.options.wallets.length)
          ]!;
    const operation = operationFor(
      wallet,
      this.random() < 0.5 ? 'BET' : 'WIN',
      '1.00',
    );
    this.history.push(operation);
    if (this.history.length > HISTORY) {
      this.history.shift();
    }
    return operation;
  }
}

export async function submit(
  baseUrl: string,
  operation: Operation,
  timeoutMs: number,
): Promise<Outcome> {
  try {
    const response = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        authorization: await bearerFor({
          providerId: operation.body.providerId,
        }),
        'content-type': 'application/json',
        'idempotency-key': operation.idempotencyKey,
      },
      body: JSON.stringify(operation.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    const replay =
      response.ok &&
      (JSON.parse(text) as { idempotentReplay?: boolean }).idempotentReplay ===
        true;
    return outcomeOfStatus(response.status, replay);
  } catch (error) {
    return outcomeOfError(error);
  }
}

export interface QueuedOperation {
  operation: Operation;
  messageId: string;
}

export async function enqueueBatch(
  sqs: SQSClient,
  queueUrl: string,
  items: readonly QueuedOperation[],
): Promise<{ sent: number; failed: number }> {
  try {
    const response = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: items.map(({ operation, messageId }, index) => ({
          Id: String(index),
          MessageBody: JSON.stringify({
            messageId,
            type: 'WagerTransactionRequested',
            occurredAt: new Date().toISOString(),
            data: {
              ...operation.body,
              idempotencyKey: operation.idempotencyKey,
            },
          }),
          MessageGroupId: operation.body.walletId,
          MessageDeduplicationId: messageId,
        })),
      }),
    );
    return {
      sent: response.Successful?.length ?? 0,
      failed: response.Failed?.length ?? 0,
    };
  } catch {
    return { sent: 0, failed: items.length };
  }
}
