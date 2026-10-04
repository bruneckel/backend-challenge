import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { bypassingLedgerGuards } from '@test/support/ledger-states';
import {
  type PersistenceHarness,
  createPersistenceHarness,
} from '@test/support/persistence';
import {
  type Wagering,
  createWagering,
  openWalletWith,
} from '@test/support/wagering';

let harness: PersistenceHarness;
let wagering: Wagering;

beforeAll(async () => {
  harness = await createPersistenceHarness();
  wagering = createWagering(harness.unitOfWork);
});

afterAll(async () => {
  await harness.close();
});

async function runReconcile(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(['bun', 'src/cli/reconcile-wallets.ts', ...args], {
    env: { ...process.env, DATABASE_URL: harness.database.url },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

const linesOf = (stdout: string) =>
  stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe('reconcile command', () => {
  test('reports every wallet consistent and exits with 0', async () => {
    await openWalletWith(wagering, '100.00');
    await openWalletWith(wagering, '0.00');

    const { exitCode, stdout } = await runReconcile(['--page-size', '1']);

    expect(exitCode).toBe(0);
    expect(linesOf(stdout).at(-1)).toMatchObject({
      level: 'info',
      msg: 'reconciliation finished',
      checked: 2,
      consistent: 2,
      divergent: 0,
    });
  });

  test('lists the wallets that diverge, without amounts, and exits with 1', async () => {
    const drifted = await openWalletWith(wagering, '100.00');
    await bypassingLedgerGuards(
      harness.database.sql,
      (tx) =>
        tx`update wallets set balance_amount = '99.00' where id = ${drifted.id}`,
    );

    const { exitCode, stdout } = await runReconcile(['--concurrency', '2']);

    expect(exitCode).toBe(1);
    const lines = linesOf(stdout);
    expect(lines.slice(0, -1)).toEqual([
      {
        level: 'warn',
        msg: 'wallet diverges',
        walletId: drifted.id,
        kinds: ['balance'],
        checkedEntries: 1,
        chainBreaks: 0,
      },
    ]);
    expect(lines.at(-1)).toMatchObject({
      msg: 'reconciliation finished',
      checked: 3,
      consistent: 2,
      divergent: 1,
    });
  });

  test('refuses an invalid option with the usage and exits with 2', async () => {
    const { exitCode, stderr } = await runReconcile(['--concurrency', '0']);

    expect(exitCode).toBe(2);
    expect(stderr).toContain('usage');
  });
});
