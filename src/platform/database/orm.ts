import { MikroORM, type Options } from '@mikro-orm/postgresql';

export const DEFAULT_POOL_SIZE = 10;
export const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;
export const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;

export interface OrmSettings {
  databaseUrl: string;
  entities: NonNullable<Options['entities']>;
  poolSize?: number;
  statementTimeoutMs?: number;
  idleInTransactionTimeoutMs?: number;
  applicationName?: string;
}

export function createOrm(settings: OrmSettings): Promise<MikroORM> {
  return MikroORM.init({
    clientUrl: settings.databaseUrl,
    entities: settings.entities,
    discovery: { warnWhenNoEntities: false },
    pool: { min: 0, max: settings.poolSize ?? DEFAULT_POOL_SIZE },
    driverOptions: {
      statement_timeout:
        settings.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
      idle_in_transaction_session_timeout:
        settings.idleInTransactionTimeoutMs ??
        DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      application_name: settings.applicationName ?? 'wagering',
    },
  });
}
