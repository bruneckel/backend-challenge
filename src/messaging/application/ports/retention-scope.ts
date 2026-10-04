import type { InboxRepository } from './inbox-repository';
import type { MaintenanceLeases } from './maintenance-leases';
import type { OutboxRepository } from './outbox-repository';

export interface RetentionScope {
  outbox: OutboxRepository;
  inbox: InboxRepository;
  leases: MaintenanceLeases;
}
