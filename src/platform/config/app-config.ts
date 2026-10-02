import { hostname } from 'node:os';
import { z } from 'zod';

export interface AppConfig {
  databaseUrl: string;
  port: number;
  instanceId: string;
  database: {
    poolSize: number;
    lockTimeoutMs: number;
    statementTimeoutMs: number;
    idleInTransactionTimeoutMs: number;
  };
  reference: {
    maxAttempts: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
  };
}

export class InvalidConfigurationError extends Error {
  constructor(problems: readonly string[]) {
    super(`Invalid configuration: ${problems.join('; ')}`);
    this.name = 'InvalidConfigurationError';
  }
}

const integer = (fallback: number, min: number, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const environmentSchema = z
  .object({
    DATABASE_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\/\S+$/, 'must be a postgres:// or postgresql:// URL')
      .default('postgresql://wagering:wagering@localhost:5432/wagering'),
    PORT: integer(3000, 0, 65535),
    INSTANCE_ID: z.string().regex(/^[\x21-\x7e]{1,64}$/, 'must be 1 to 64 visible ASCII characters').optional(),
    DB_POOL_SIZE: integer(10, 1),
    DB_LOCK_TIMEOUT_MS: integer(3000, 1),
    DB_STATEMENT_TIMEOUT_MS: integer(10_000, 1),
    DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: integer(30_000, 1),
    REFERENCE_MAX_ATTEMPTS: integer(10, 1),
    REFERENCE_BACKOFF_BASE_MS: integer(2000, 1),
    REFERENCE_BACKOFF_MAX_MS: integer(120_000, 1),
  })
  .refine((env) => env.REFERENCE_BACKOFF_MAX_MS >= env.REFERENCE_BACKOFF_BASE_MS, {
    path: ['REFERENCE_BACKOFF_MAX_MS'],
    message: 'must not be lower than REFERENCE_BACKOFF_BASE_MS',
  });

export function loadConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ''));
  const parsed = environmentSchema.safeParse(present);
  if (!parsed.success) {
    throw new InvalidConfigurationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`),
    );
  }
  const values = parsed.data;
  return {
    databaseUrl: values.DATABASE_URL,
    port: values.PORT,
    instanceId: values.INSTANCE_ID ?? `${hostname()}-${process.pid}`,
    database: {
      poolSize: values.DB_POOL_SIZE,
      lockTimeoutMs: values.DB_LOCK_TIMEOUT_MS,
      statementTimeoutMs: values.DB_STATEMENT_TIMEOUT_MS,
      idleInTransactionTimeoutMs: values.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    },
    reference: {
      maxAttempts: values.REFERENCE_MAX_ATTEMPTS,
      backoffBaseMs: values.REFERENCE_BACKOFF_BASE_MS,
      backoffMaxMs: values.REFERENCE_BACKOFF_MAX_MS,
    },
  };
}
