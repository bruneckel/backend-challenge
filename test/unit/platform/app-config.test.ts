import { describe, expect, test } from 'bun:test';
import { InvalidConfigurationError, loadConfig } from '@platform/config/app-config';

describe('loadConfig', () => {
  test('uses local development defaults when nothing is set', () => {
    expect(loadConfig({})).toEqual({
      databaseUrl: 'postgresql://wagering:wagering@localhost:5432/wagering',
      port: 3000,
      instanceId: expect.any(String),
      database: { poolSize: 10, lockTimeoutMs: 3000, statementTimeoutMs: 10000, idleInTransactionTimeoutMs: 30000 },
      reference: { maxAttempts: 10, backoffBaseMs: 2000, backoffMaxMs: 120000 },
    });
  });

  test('reads every setting from the environment', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://user:secret@db:5432/wagering',
      PORT: '0',
      INSTANCE_ID: 'api-2',
      DB_POOL_SIZE: '20',
      DB_LOCK_TIMEOUT_MS: '500',
      DB_STATEMENT_TIMEOUT_MS: '2000',
      DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '4000',
      REFERENCE_MAX_ATTEMPTS: '3',
      REFERENCE_BACKOFF_BASE_MS: '100',
      REFERENCE_BACKOFF_MAX_MS: '400',
    });

    expect(config).toEqual({
      databaseUrl: 'postgres://user:secret@db:5432/wagering',
      port: 0,
      instanceId: 'api-2',
      database: { poolSize: 20, lockTimeoutMs: 500, statementTimeoutMs: 2000, idleInTransactionTimeoutMs: 4000 },
      reference: { maxAttempts: 3, backoffBaseMs: 100, backoffMaxMs: 400 },
    });
  });

  test('fails fast naming every invalid variable without echoing its value', () => {
    const load = () =>
      loadConfig({ DATABASE_URL: 'mysql://user:secret@db/wagering', DB_POOL_SIZE: '0', REFERENCE_MAX_ATTEMPTS: 'many' });

    expect(load).toThrow(InvalidConfigurationError);
    expect(load).toThrow(/DATABASE_URL.*DB_POOL_SIZE.*REFERENCE_MAX_ATTEMPTS/s);
    expect(load).not.toThrow(/secret/);
  });

  test('refuses a reference backoff whose cap is below its base', () => {
    expect(() => loadConfig({ REFERENCE_BACKOFF_BASE_MS: '5000', REFERENCE_BACKOFF_MAX_MS: '1000' })).toThrow(
      /REFERENCE_BACKOFF_MAX_MS/,
    );
  });
});
