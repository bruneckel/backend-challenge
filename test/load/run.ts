import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { stopAll } from './cluster';
import { parseLoadArgs } from './config';
import { ROOT, environmentInfo, startInfra, stopInfra } from './infra';
import { renderReport } from './report';
import { runScenario } from './scenario';
import type { ScenarioResult } from './types';

const log = (message: string) =>
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);

const run = parseLoadArgs(Bun.argv.slice(2));
const startedAt = new Date().toISOString();
const stamp = startedAt.replace(/[-:.TZ]/g, '').slice(0, 14);
const runDir = resolve(ROOT, run.output, stamp);
await mkdir(runDir, { recursive: true });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log(`${signal} received, stopping the application processes`);
    void stopAll('SIGKILL').finally(() => {
      log('infrastructure kept up: docker compose -p wagering-load down -v');
      process.exit(130);
    });
  });
}

log(`starting isolated infrastructure (project wagering-load)`);
await startInfra();
const environment = await environmentInfo(startedAt);
const results: ScenarioResult[] = [];
let failed = false;
try {
  for (const [index, scenario] of run.scenarios.entries()) {
    log(`scenario ${scenario.name} (${scenario.profile}, ${scenario.channel})`);
    const result = await runScenario(
      scenario,
      `${stamp}_${index}`,
      `${runDir}/${scenario.name}`,
      run.keepData,
    );
    results.push(result);
    const { consistency } = result;
    if (consistency.violations.length > 0 || !consistency.drained) {
      failed = true;
    }
    log(
      `  done: ${consistency.violations.length} violations, drained ${consistency.drained}`,
    );
    await Bun.write(
      `${runDir}/results.json`,
      JSON.stringify({ environment, results }, null, 2),
    );
    await Bun.write(`${runDir}/report.md`, renderReport(environment, results));
  }
} finally {
  if (!run.keepInfra) {
    await stopInfra();
  }
}
log(`report: ${runDir}/report.md`);
process.exit(failed ? 1 : 0);
