import { migrateDown, migrateUp } from './migrator';

const LOCAL_DATABASE_URL = 'postgresql://wagering:wagering@localhost:5432/wagering';

const command = process.argv[2];
const databaseUrl = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;

if (command === 'up') {
  const applied = await migrateUp(databaseUrl);
  process.stdout.write(`${JSON.stringify({ level: 'info', msg: 'migrations applied', migrations: applied })}\n`);
} else if (command === 'down') {
  const reverted = await migrateDown(databaseUrl);
  process.stdout.write(`${JSON.stringify({ level: 'info', msg: 'migrations reverted', migrations: reverted })}\n`);
} else {
  process.stderr.write('usage: bun src/platform/database/migrate.ts up|down\n');
  process.exit(1);
}
