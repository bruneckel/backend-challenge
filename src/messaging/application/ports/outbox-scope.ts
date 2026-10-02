import type { OutboxRepository } from './outbox-repository';

export interface OutboxScope {
  outbox: OutboxRepository;
}
