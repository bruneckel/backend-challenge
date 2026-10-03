import type { InboxRepository } from './inbox-repository';
import type { OutboxRepository } from './outbox-repository';

export interface RetentionScope {
  outbox: OutboxRepository;
  inbox: InboxRepository;
}
