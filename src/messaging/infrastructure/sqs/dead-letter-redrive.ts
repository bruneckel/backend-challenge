import { randomUUID } from 'node:crypto';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

export interface DeadLetterQueues {
  deadLetter: string;
  commands: string;
}

export interface DeadLetterSummary {
  sqsMessageId: string;
  messageId: string | undefined;
  groupId: string | undefined;
  reason: string;
  deadLetteredAt: string | undefined;
}

export interface DeadLetterListing {
  approximateTotal: number;
  messages: DeadLetterSummary[];
}

export interface RedriveRequest {
  reasons: ReadonlySet<string>;
  limit?: number;
  dryRun?: boolean;
}

export interface RedriveReport {
  dryRun: boolean;
  redriven: DeadLetterSummary[];
  held: DeadLetterSummary[];
}

export interface DeadLetterRedriveOptions {
  holdSeconds?: number;
  waitSeconds?: number;
}

export const UNKNOWN_REASON = 'UNKNOWN';

const IDLE_RECEIVES = 2;

function messageIdIn(body: string | undefined): string | undefined {
  try {
    const parsed = JSON.parse(body ?? '') as { messageId?: unknown };
    return typeof parsed.messageId === 'string' ? parsed.messageId : undefined;
  } catch {
    return undefined;
  }
}

function summaryOf(message: Message): DeadLetterSummary {
  return {
    sqsMessageId: message.MessageId ?? '',
    messageId: messageIdIn(message.Body),
    groupId: message.Attributes?.MessageGroupId,
    reason: message.MessageAttributes?.reason?.StringValue ?? UNKNOWN_REASON,
    deadLetteredAt: message.MessageAttributes?.deadLetteredAt?.StringValue,
  };
}

export class DeadLetterRedrive {
  private readonly holdSeconds: number;
  private readonly waitSeconds: number;

  constructor(
    private readonly client: SQSClient,
    private readonly queues: DeadLetterQueues,
    options: DeadLetterRedriveOptions = {},
  ) {
    this.holdSeconds = options.holdSeconds ?? 60;
    this.waitSeconds = options.waitSeconds ?? 1;
  }

  async list(limit = 100): Promise<DeadLetterListing> {
    const approximateTotal = await this.approximateTotal();
    const held = new Map<string, Message>();
    const messages: DeadLetterSummary[] = [];
    try {
      let idle = 0;
      while (idle < IDLE_RECEIVES && messages.length < limit) {
        const batch = await this.receive();
        idle = batch.length === 0 ? idle + 1 : 0;
        for (const message of batch) {
          const summary = summaryOf(message);
          if (!held.has(summary.sqsMessageId)) {
            messages.push(summary);
          }
          held.set(summary.sqsMessageId, message);
        }
      }
    } finally {
      await this.release(held.values());
    }
    return { approximateTotal, messages: messages.slice(0, limit) };
  }

  async redrive(request: RedriveRequest): Promise<RedriveReport> {
    const limit = request.limit ?? Number.POSITIVE_INFINITY;
    const report: RedriveReport = {
      dryRun: request.dryRun ?? false,
      redriven: [],
      held: [],
    };
    const held = new Map<string, Message>();
    const blockedGroups = new Set<string | undefined>();
    try {
      let idle = 0;
      while (idle < IDLE_RECEIVES && report.redriven.length < limit) {
        const batch = await this.receive();
        idle = batch.length === 0 ? idle + 1 : 0;
        for (const message of batch) {
          const summary = summaryOf(message);
          const seen = held.has(summary.sqsMessageId);
          const eligible =
            !seen &&
            !blockedGroups.has(summary.groupId) &&
            request.reasons.has(summary.reason) &&
            report.redriven.length < limit;
          if (eligible && !report.dryRun) {
            await this.sendBack(message, summary);
            await this.delete(message);
            report.redriven.push(summary);
            continue;
          }
          held.set(summary.sqsMessageId, message);
          blockedGroups.add(summary.groupId);
          if (!seen) {
            (eligible ? report.redriven : report.held).push(summary);
          }
        }
      }
    } finally {
      await this.release(held.values());
    }
    return report;
  }

  private async receive(): Promise<Message[]> {
    const { Messages = [] } = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queues.deadLetter,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: this.waitSeconds,
        VisibilityTimeout: this.holdSeconds,
        MessageSystemAttributeNames: ['MessageGroupId'],
        MessageAttributeNames: ['All'],
      }),
    );
    return Messages;
  }

  private async sendBack(
    message: Message,
    summary: DeadLetterSummary,
  ): Promise<void> {
    if (summary.groupId === undefined) {
      throw new Error(
        `Dead letter ${summary.sqsMessageId} has no message group to send it back to`,
      );
    }
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queues.commands,
        MessageBody: message.Body,
        MessageGroupId: summary.groupId,
        MessageDeduplicationId: `redrive-${randomUUID()}`,
        MessageAttributes: {
          redrivenFrom: {
            DataType: 'String',
            StringValue: summary.sqsMessageId,
          },
          redrivenReason: { DataType: 'String', StringValue: summary.reason },
        },
      }),
    );
  }

  private async delete(message: Message): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.queues.deadLetter,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  private async release(messages: Iterable<Message>): Promise<void> {
    for (const message of messages) {
      await this.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.queues.deadLetter,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      );
    }
  }

  private async approximateTotal(): Promise<number> {
    const { Attributes } = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.queues.deadLetter,
        AttributeNames: ['ApproximateNumberOfMessages'],
      }),
    );
    return Number(Attributes?.ApproximateNumberOfMessages ?? 0);
  }
}
