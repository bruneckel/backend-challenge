import { PinoLogger } from '@observability/logger/pino-logger';
import { migrateDown, migrateUp } from './migrator';

const LOCAL_DATABASE_URL =
  'postgresql://wagering:wagering@localhost:5432/wagering';

const command = process.argv[2];
const databaseUrl = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;
const logger = new PinoLogger({ role: 'migrate', instanceId: 'cli' });

if (command === 'up') {
  const applied = await migrateUp(databaseUrl);
  logger.info('migrations applied', {
    count: applied.length,
    migrations: applied.join(','),
  });
} else if (command === 'down') {
  const reverted = await migrateDown(databaseUrl);
  logger.info('migrations reverted', {
    count: reverted.length,
    migrations: reverted.join(','),
  });
} else {
  process.stderr.write('usage: bun src/platform/database/migrate.ts up|down\n');
  process.exit(1);
}
