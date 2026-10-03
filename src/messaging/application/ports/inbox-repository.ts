import type { InboxMessage } from '@messaging/domain/inbox-message';

export type InboxRecording =
  { recorded: true } | { recorded: false; existing: InboxMessage };

export interface InboxRepository {
  record(message: InboxMessage): Promise<InboxRecording>;
  saveProcessed(
    message: InboxMessage,
    transactionId: string | undefined,
  ): Promise<void>;
  deleteProcessedBefore(cutoff: Date, limit: number): Promise<number>;
}
