import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxScope } from '@messaging/application/ports/outbox-scope';
import { MikroOrmOutboxRepository } from './mikro-orm-outbox-repository';

export function createOutboxScope(em: EntityManager): OutboxScope {
  return { outbox: new MikroOrmOutboxRepository(em) };
}
