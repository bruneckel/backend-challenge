import { ensureQueues } from '@messaging/infrastructure/sqs/queue-provisioning';
import { createSqsClient } from '@messaging/infrastructure/sqs/sqs-client';
import { PinoLogger } from '@observability/logger/pino-logger';
import { loadConfig } from '@platform/config/app-config';
import { migrateUp } from '@platform/database/migrator';

const REDRIVE_MAX_RECEIVE_COUNT = 10;

const logger = new PinoLogger({ role: 'bootstrap', instanceId: 'bootstrap' });

try {
  const config = loadConfig(process.env);
  const applied = await migrateUp(config.databaseUrl);
  const client = createSqsClient(config.sqs);
  try {
    await ensureQueues(
      client,
      {
        commands: config.sqs.commandsQueue,
        deadLetter: config.sqs.deadLetterQueue,
        events: config.sqs.eventsQueue,
      },
      {
        maxReceiveCount: REDRIVE_MAX_RECEIVE_COUNT,
        visibilityTimeoutSeconds: config.consumer.visibilityTimeoutSeconds,
      },
    );
  } finally {
    client.destroy();
  }
  logger.info('bootstrap complete', {
    appliedMigrations: applied.length,
    migrations: applied.join(','),
    queues: [
      config.sqs.commandsQueue,
      config.sqs.deadLetterQueue,
      config.sqs.eventsQueue,
    ].join(','),
  });
} catch (error) {
  logger.error('bootstrap failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
}
