import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { migrations } from './migrations';

export const MIGRATIONS_TABLE = 'mikro_orm_migrations';

async function withMigrator<T>(
  databaseUrl: string,
  action: (orm: MikroORM) => Promise<T>,
): Promise<T> {
  const orm = await MikroORM.init({
    clientUrl: databaseUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      migrationsList: migrations,
      tableName: MIGRATIONS_TABLE,
      allOrNothing: false,
      snapshot: false,
      silent: true,
    },
  });
  try {
    return await action(orm);
  } finally {
    await orm.close(true);
  }
}

export async function migrateUp(databaseUrl: string): Promise<string[]> {
  const applied = await withMigrator(databaseUrl, (orm) => orm.migrator.up());
  return applied.map((migration) => migration.name);
}

export async function migrateDown(databaseUrl: string): Promise<string[]> {
  const reverted = await withMigrator(databaseUrl, (orm) =>
    orm.migrator.down({ to: 0 }),
  );
  return reverted.map((migration) => migration.name);
}
