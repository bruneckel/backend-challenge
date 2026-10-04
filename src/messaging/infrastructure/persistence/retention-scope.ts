import type { EntityManager } from '@mikro-orm/postgresql';
import type { RetentionScope } from '@messaging/application/ports/retention-scope';
import { MikroOrmInboxRepository } from './mikro-orm-inbox-repository';
import { MikroOrmMaintenanceLeases } from './mikro-orm-maintenance-leases';
import { MikroOrmOutboxRepository } from './mikro-orm-outbox-repository';

export function createRetentionScope(em: EntityManager): RetentionScope {
  return {
    outbox: new MikroOrmOutboxRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    leases: new MikroOrmMaintenanceLeases(em),
  };
}
