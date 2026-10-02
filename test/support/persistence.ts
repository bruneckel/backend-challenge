import type { MikroORM } from '@mikro-orm/postgresql';
import { messagingEntities } from '@messaging/infrastructure/persistence/messaging-entities';
import { MikroOrmUnitOfWork } from '@platform/database/mikro-orm-unit-of-work';
import { createOrm } from '@platform/database/orm';
import type { UnitOfWork } from '@shared/application/unit-of-work';
import type { WageringScope } from '@wallet/application/ports/wagering-scope';
import { createWageringScope } from '@wallet/infrastructure/persistence/wagering-scope';
import { walletEntities } from '@wallet/infrastructure/persistence/wallet-entities';
import { type TestDatabase, createMigratedDatabase } from './database';

export interface PersistenceHarness {
  readonly database: TestDatabase;
  readonly orm: MikroORM;
  readonly unitOfWork: UnitOfWork<WageringScope>;
  close(): Promise<void>;
}

export async function createPersistenceHarness(): Promise<PersistenceHarness> {
  const database = await createMigratedDatabase();
  const orm = await createOrm({ databaseUrl: database.url, entities: [...walletEntities, ...messagingEntities] });
  const unitOfWork = new MikroOrmUnitOfWork(orm, createWageringScope, { lockTimeoutMs: 2000 });
  return {
    database,
    orm,
    unitOfWork,
    async close() {
      await orm.close(true);
      await database.drop();
    },
  };
}

export function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
