import { parseArgs } from 'node:util';
import {
  DeadLetterRedrive,
  type DeadLetterSummary,
} from '@messaging/infrastructure/sqs/dead-letter-redrive';
import { queueUrlOf } from '@messaging/infrastructure/sqs/queue-provisioning';
import { createSqsClient } from '@messaging/infrastructure/sqs/sqs-client';
import { loadConfig } from '@platform/config/app-config';
import { REDRIVABLE_REASONS } from '@wallet/infrastructure/messaging/consumer-failures';

const USAGE = `usage: bun run dlq list [--limit 100]
       bun run dlq redrive --reason <${[...REDRIVABLE_REASONS].join('|')}> [--reason …] [--limit N] [--dry-run]
`;

function fail(message: string): never {
  process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
  process.exit(1);
}

function write(entry: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ level: 'info', ...entry })}\n`);
}

function describe(summary: DeadLetterSummary): Record<string, unknown> {
  return {
    messageId: summary.messageId,
    walletId: summary.groupId,
    reason: summary.reason,
    deadLetteredAt: summary.deadLetteredAt,
    sqsMessageId: summary.sqsMessageId,
  };
}

const { positionals, values } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        reason: { type: 'string', multiple: true },
        limit: { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
    });
  } catch (error) {
    return fail(`${(error as Error).message}\n${USAGE}`);
  }
})();

const [command] = positionals;
if (command !== 'list' && command !== 'redrive') {
  fail(USAGE);
}
const limit = values.limit === undefined ? undefined : Number(values.limit);
if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
  fail(`--limit must be a positive integer\n${USAGE}`);
}
const reasons = values.reason ?? [];
if (command === 'redrive') {
  if (reasons.length === 0) {
    fail(USAGE);
  }
  for (const reason of reasons) {
    if (!(REDRIVABLE_REASONS as ReadonlySet<string>).has(reason)) {
      fail(
        `${reason} cannot be sent back: only ${[...REDRIVABLE_REASONS].join(' and ')} can, after the cause is fixed`,
      );
    }
  }
}

const config = loadConfig(process.env);
const client = createSqsClient(config.sqs);
try {
  const tool = new DeadLetterRedrive(client, {
    deadLetter: await queueUrlOf(client, config.sqs.deadLetterQueue),
    commands: await queueUrlOf(client, config.sqs.commandsQueue),
  });
  if (command === 'list') {
    const listing = await tool.list(limit);
    for (const summary of listing.messages) {
      write({ msg: 'dead letter', ...describe(summary) });
    }
    write({
      msg: 'dead letters listed',
      approximateTotal: listing.approximateTotal,
      shown: listing.messages.length,
    });
  } else {
    const report = await tool.redrive({
      reasons: new Set(reasons),
      limit,
      dryRun: values['dry-run'] === true,
    });
    for (const summary of report.redriven) {
      write({
        msg: report.dryRun
          ? 'dead letter would be sent back'
          : 'dead letter sent back',
        ...describe(summary),
      });
    }
    write({
      msg: 'dead letters sent back',
      dryRun: report.dryRun,
      redriven: report.redriven.length,
      held: report.held.length,
      heldReasons: Object.fromEntries(
        [...new Set(report.held.map((item) => item.reason))].map((reason) => [
          reason,
          report.held.filter((item) => item.reason === reason).length,
        ]),
      ),
    });
  }
} catch (error) {
  fail(
    JSON.stringify({
      level: 'error',
      msg: 'dead letter command failed',
      error: error instanceof Error ? error.message : String(error),
    }),
  );
} finally {
  client.destroy();
}
