import type { LatencySummary } from './stats';
import type {
  EnvironmentInfo,
  Quantiles,
  ScenarioResult,
  StepResult,
} from './types';

const SUCCESS = new Set(['ok', 'replay', 'rejected']);

const decimal = (value: number | undefined, digits = 1) =>
  value === undefined || Number.isNaN(value) ? '—' : value.toFixed(digits);

const milliseconds = (seconds: number | undefined) =>
  seconds === undefined ? '—' : decimal(seconds * 1000);

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;

function errorsOf(outcomes: Record<string, number>): number {
  return Object.entries(outcomes)
    .filter(([outcome]) => !SUCCESS.has(outcome))
    .reduce((total, [, count]) => total + count, 0);
}

function verdict(result: ScenarioResult): string {
  const { violations, drained } = result.consistency;
  if (violations.length > 0) {
    return `**${violations.length} ${violations.length === 1 ? 'violação' : 'violações'}**`;
  }
  return drained ? 'ok' : '**não drenou**';
}

function bestStep(steps: readonly StepResult[]): StepResult | undefined {
  return [...steps].sort(
    (left, right) => right.throughput - left.throughput,
  )[0];
}

interface Row {
  channel: string;
  throughput: number;
  latency: LatencySummary;
  errors: number;
}

function rowsOf(result: ScenarioResult): Row[] {
  const rows: Row[] = [];
  const best = result.steps === undefined ? undefined : bestStep(result.steps);
  if (best !== undefined) {
    rows.push({
      channel: `http (c=${best.concurrency})`,
      throughput: best.throughput,
      latency: best.latency,
      errors: Math.round(best.errorRate * best.completed),
    });
  } else if (result.http !== undefined) {
    rows.push({
      channel: result.sqs === undefined ? 'http' : 'mixed/http',
      throughput: result.http.throughput,
      latency: result.http.latency,
      errors: errorsOf(result.http.outcomes),
    });
  }
  if (result.sqs !== undefined) {
    rows.push({
      channel: result.http === undefined ? 'sqs' : 'mixed/sqs',
      throughput: result.sqs.throughput,
      latency: result.sqs.endToEnd,
      errors: result.sqs.sendFailures + result.server.deadLettered,
    });
  }
  return rows;
}

function quantiles(value: Quantiles): string {
  return `${milliseconds(value.p50)} / ${milliseconds(value.p95)} / ${milliseconds(value.p99)}`;
}

function latencyLine(summary: LatencySummary): string {
  return `${summary.count} amostras; média ${decimal(summary.mean)} ms; p50 ${decimal(summary.p50)}; p90 ${decimal(summary.p90)}; p95 ${decimal(summary.p95)}; p99 ${decimal(summary.p99)}; máx ${decimal(summary.max)} ms`;
}

function scenarioSection(result: ScenarioResult): string[] {
  const { config, server, consistency } = result;
  const lines = [
    `### ${config.name}`,
    '',
    `Parâmetros: perfil \`${config.profile}\`, canal \`${config.channel}\`, ${config.apiInstances} api / ${config.workerInstances} worker, ${config.wallets} wallets, ${percent(config.hotShare)} na wallet quente, replays ${percent(config.replayShare)}, taxa ${config.rate}/s, pico ${config.spikeRate}/s, aquecimento ${config.warmupSeconds} s, duração ${config.durationSeconds} s, pool ${config.dbPoolSize}, log \`${config.logLevel}\`. Janela medida: ${decimal(result.measuredSeconds)} s.`,
    '',
  ];
  if (result.http !== undefined && result.steps === undefined) {
    const outcomes = Object.entries(result.http.outcomes)
      .filter(([, count]) => count > 0)
      .map(([outcome, count]) => `${outcome} ${count}`)
      .join(', ');
    lines.push(
      `- HTTP: ${result.http.offered} ofertadas, ${result.http.completed} concluídas (${outcomes || 'nenhuma'}); vazão ${decimal(result.http.throughput)}/s.`,
      `- Latência HTTP: ${latencyLine(result.http.latency)}.`,
    );
  }
  if (result.sqs !== undefined) {
    lines.push(
      `- SQS: ${result.sqs.sent} enviadas (${result.sqs.sendFailures} falhas de envio), ${result.sqs.processed} processadas; vazão ${decimal(result.sqs.throughput)}/s.`,
      `- Latência ponta a ponta SQS (envio → processamento): ${latencyLine(result.sqs.endToEnd)}.`,
    );
  }
  if (result.steps !== undefined) {
    lines.push(
      '| Concorrência | Concluídas | Vazão/s | Erros | p50 ms | p95 ms | p99 ms |',
      '|---|---|---|---|---|---|---|',
      ...result.steps.map(
        (step) =>
          `| ${step.concurrency} | ${step.completed} | ${decimal(step.throughput)} | ${percent(step.errorRate)} | ${decimal(step.latency.p50)} | ${decimal(step.latency.p95)} | ${decimal(step.latency.p99)} |`,
      ),
      '',
    );
  }
  if (result.outage !== undefined) {
    const outage = result.outage;
    lines.push(
      `- Queda do PostgreSQL: do segundo ${outage.startSecond} ao ${outage.endSecond}; ${outage.failuresDuringOutage} falhas na janela; primeiro sucesso ${outage.firstSuccessAfterMs === null ? 'não observado' : `${decimal(outage.firstSuccessAfterMs, 0)} ms`} após a volta; vazão normal ${outage.recoveredAfterMs === null ? 'não recuperada na janela' : `${decimal(outage.recoveredAfterMs, 0)} ms`} após a volta.`,
    );
  }
  const timeline = result.http?.timeline ?? [];
  if (
    (config.profile === 'spike' || config.profile === 'recovery') &&
    timeline.length > 0
  ) {
    lines.push(
      '',
      'Linha do tempo HTTP (por segundo da janela medida):',
      '',
      '| Segundo | OK | Falhas | p50 ms | p99 ms |',
      '|---|---|---|---|---|',
      ...timeline.map(
        (bucket) =>
          `| ${bucket.second} | ${bucket.ok} | ${bucket.failed} | ${decimal(bucket.p50)} | ${decimal(bucket.p99)} |`,
      ),
      '',
    );
  }
  const transactions = server.transactions
    .map((entry) => `${entry.channel}/${entry.status} ${entry.count}`)
    .join(', ');
  lines.push(
    `- Servidor: transações ${transactions || 'nenhuma'}; replays ${server.replays}; conflitos ${server.conflicts}; duplicatas na inbox ${server.inboxDuplicates}; retries de transação ${server.dbRetries}; timeouts de lock ${server.lockTimeouts}; conflitos de versão ${server.versionConflicts}; retries SQS ${server.sqsRetries}; DLQ ${server.deadLettered}.`,
    `- Espera pelo lock da wallet (p50 / p95 / p99, ms): ${quantiles(server.lockWait)}.`,
    ...Object.entries(server.processing).map(
      ([channel, value]) =>
        `- Processamento no servidor, ${channel} (p50 / p95 / p99, ms): ${quantiles(value)}.`,
    ),
    `- Outbox: atraso de publicação (p50 / p95 / p99, ms) ${quantiles(server.outboxDelay)}; maior idade pendente ${decimal(server.maxOutboxAgeSeconds)} s; maior fila ${server.maxOutboxPending}. Conexões ao banco (máximo): ${server.maxConnections}.`,
    `- Consistência: ${consistency.wallets} wallets conferidas; ${consistency.violations.length} violações; drenagem ${consistency.drained ? `em ${decimal(consistency.drainSeconds)} s` : 'incompleta'}; DLQ ${consistency.dlqDepth}; eventos não publicados ${consistency.unpublished}; referências pendentes ${consistency.pendingReferences}.`,
    ...consistency.violations.map((violation) => `  - ${violation}`),
    `- Gerador: CPU ${decimal(result.generator.cpuPercent)}% de um núcleo.`,
    '',
  );
  return lines;
}

export function renderReport(
  environment: EnvironmentInfo,
  results: readonly ScenarioResult[],
): string {
  const lines = [
    `# Relatório de carga — ${environment.startedAt}`,
    '',
    '## Ambiente',
    '',
    '| Item | Valor |',
    '|---|---|',
    `| Commit | \`${environment.commit}\` (${environment.branch}) |`,
    `| Sistema | ${environment.os} |`,
    `| CPU | ${environment.cpu} (${environment.cpus} núcleos) |`,
    `| Memória | ${environment.memoryGb} GB |`,
    `| Bun | ${environment.bun} |`,
    `| Docker | ${environment.docker} (${environment.dockerCpus} CPUs, ${environment.dockerMemoryGb} GB) |`,
    `| PostgreSQL | ${environment.postgres} |`,
    `| SQS | ${environment.ministack} |`,
    '',
    '## Resumo',
    '',
    'Latências em ms. Vazão em operações concluídas com sucesso por segundo. Em saturação, a linha mostra o degrau de maior vazão. Em SQS, a latência é do envio ao processamento.',
    '',
    '| Cenário | Perfil | Canal | api/worker | Wallets (quente) | Vazão/s | p50 | p95 | p99 | Erros | Consistência |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const result of results) {
    const { config } = result;
    for (const row of rowsOf(result)) {
      lines.push(
        `| ${config.name} | ${config.profile} | ${row.channel} | ${config.apiInstances}/${config.workerInstances} | ${config.wallets} (${percent(config.hotShare)}) | ${decimal(row.throughput)} | ${decimal(row.latency.p50)} | ${decimal(row.latency.p95)} | ${decimal(row.latency.p99)} | ${row.errors} | ${verdict(result)} |`,
      );
    }
  }
  lines.push('', '## Cenários', '');
  for (const result of results) {
    lines.push(...scenarioSection(result));
  }
  return `${lines.join('\n')}\n`;
}
