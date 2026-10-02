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
  sqs: {
    endpoint: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    commandsQueue: string;
    deadLetterQueue: string;
    eventsQueue: string;
    publishTimeoutMs: number;
  };
  outbox: {
    batchSize: number;
    pollIntervalMs: number;
    retryBaseMs: number;
    retryMaxMs: number;
  };
  worker: {
    publisherEnabled: boolean;
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

const fifoQueue = (fallback: string) =>
  z.string().regex(/^[A-Za-z0-9_-]{1,75}\.fifo$/, 'must be a FIFO queue name ending in .fifo').default(fallback);

const toggle = (fallback: boolean) =>
  z
    .enum(['true', 'false'])
    .default(fallback ? 'true' : 'false')
    .transform((value) => value === 'true');

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
    AWS_ENDPOINT_URL: z.url().default('http://localhost:4566'),
    AWS_REGION: z.string().regex(/^[a-z0-9-]{1,32}$/, 'must be an AWS region name').default('us-east-1'),
    AWS_ACCESS_KEY_ID: z.string().min(1).default('test'),
    AWS_SECRET_ACCESS_KEY: z.string().min(1).default('test'),
    SQS_COMMANDS_QUEUE: fifoQueue('wager-transactions.fifo'),
    SQS_DEAD_LETTER_QUEUE: fifoQueue('wager-transactions-dlq.fifo'),
    SQS_EVENTS_QUEUE: fifoQueue('wagering-events.fifo'),
    SQS_PUBLISH_TIMEOUT_MS: integer(5000, 1),
    OUTBOX_BATCH_SIZE: integer(10, 1, 10),
    OUTBOX_POLL_INTERVAL_MS: integer(500, 1),
    OUTBOX_RETRY_BASE_MS: integer(1000, 1),
    OUTBOX_RETRY_MAX_MS: integer(300_000, 1),
    OUTBOX_PUBLISHER_ENABLED: toggle(true),
  })
  .refine((env) => env.REFERENCE_BACKOFF_MAX_MS >= env.REFERENCE_BACKOFF_BASE_MS, {
    path: ['REFERENCE_BACKOFF_MAX_MS'],
    message: 'must not be lower than REFERENCE_BACKOFF_BASE_MS',
  })
  .refine((env) => env.OUTBOX_RETRY_MAX_MS >= env.OUTBOX_RETRY_BASE_MS, {
    path: ['OUTBOX_RETRY_MAX_MS'],
    message: 'must not be lower than OUTBOX_RETRY_BASE_MS',
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
    sqs: {
      endpoint: values.AWS_ENDPOINT_URL,
      region: values.AWS_REGION,
      accessKeyId: values.AWS_ACCESS_KEY_ID,
      secretAccessKey: values.AWS_SECRET_ACCESS_KEY,
      commandsQueue: values.SQS_COMMANDS_QUEUE,
      deadLetterQueue: values.SQS_DEAD_LETTER_QUEUE,
      eventsQueue: values.SQS_EVENTS_QUEUE,
      publishTimeoutMs: values.SQS_PUBLISH_TIMEOUT_MS,
    },
    outbox: {
      batchSize: values.OUTBOX_BATCH_SIZE,
      pollIntervalMs: values.OUTBOX_POLL_INTERVAL_MS,
      retryBaseMs: values.OUTBOX_RETRY_BASE_MS,
      retryMaxMs: values.OUTBOX_RETRY_MAX_MS,
    },
    worker: {
      publisherEnabled: values.OUTBOX_PUBLISHER_ENABLED,
    },
  };
}
