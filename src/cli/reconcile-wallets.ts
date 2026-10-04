import { parseArgs } from 'node:util';
import { messagingEntities } from '@messaging/infrastructure/persistence/messaging-entities';
import { loadConfig } from '@platform/config/app-config';
import { MikroOrmUnitOfWork } from '@platform/database/mikro-orm-unit-of-work';
import { createOrm } from '@platform/database/orm';
import { silentLogger } from '@shared/application/logger';
import { noopMetrics } from '@shared/application/metrics';
import { ReconcileAllWallets } from '@wallet/application/use-cases/reconcile-all-wallets';
import {
  ReconcileWallet,
  type ReconciliationReport,
} from '@wallet/application/use-cases/reconcile-wallet';
import { createWageringScope } from '@wallet/infrastructure/persistence/wagering-scope';
import { walletEntities } from '@wallet/infrastructure/persistence/wallet-entities';

const USAGE = `usage: bun run reconcile [--page-size 1000] [--concurrency 4] [--limit N] [--after <walletId>]
`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fail(message: string): never {
  process.stderr.write(`${message}\n${USAGE}`);
  process.exit(2);
}

function write(entry: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

function positive(name: string, value: string | undefined, fallback?: number) {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    fail(`--${name} must be a positive integer`);
  }
  return parsed;
}

function kindsOf(report: ReconciliationReport): string[] {
  return [
    ...(report.storedBalance.amount === report.calculatedBalance.amount
      ? []
      : ['balance']),
    ...(report.chainBreaks > 0 ? ['chain'] : []),
    ...(report.versionConsistent ? [] : ['version']),
  ];
}

const { values } = (() => {
  try {
    return parseArgs({
      options: {
        'page-size': { type: 'string' },
        concurrency: { type: 'string' },
        limit: { type: 'string' },
        after: { type: 'string' },
      },
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
})();

const pageSize = positive('page-size', values['page-size'], 1000) ?? 1000;
const concurrency = positive('concurrency', values.concurrency, 4) ?? 4;
const limit = positive('limit', values.limit);
if (values.after !== undefined && !UUID.test(values.after)) {
  fail('--after must be a wallet id');
}

const config = loadConfig(process.env);
const orm = await createOrm({
  databaseUrl: config.databaseUrl,
  entities: [...walletEntities, ...messagingEntities],
  poolSize: concurrency + 1,
  statementTimeoutMs: config.database.statementTimeoutMs,
  applicationName: 'wagering-reconcile',
});
try {
  const unitOfWork = new MikroOrmUnitOfWork(orm, createWageringScope, {
    lockTimeoutMs: config.database.lockTimeoutMs,
  });
  const reconcile = new ReconcileWallet({
    unitOfWork,
    metrics: noopMetrics,
    logger: silentLogger,
  });
  const started = performance.now();
  const summary = await new ReconcileAllWallets({
    unitOfWork,
    reconcile,
  }).execute({
    pageSize,
    concurrency,
    limit,
    after: values.after,
    onDivergence: (report) =>
      write({
        level: 'warn',
        msg: 'wallet diverges',
        walletId: report.walletId,
        kinds: kindsOf(report),
        checkedEntries: report.checkedEntries,
        chainBreaks: report.chainBreaks,
      }),
  });
  write({
    level: 'info',
    msg: 'reconciliation finished',
    ...summary,
    seconds: Math.round((performance.now() - started) / 100) / 10,
  });
  process.exitCode = summary.divergent > 0 ? 1 : 0;
} catch (error) {
  process.stderr.write(
    `reconciliation failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
} finally {
  await orm.close(true);
}
