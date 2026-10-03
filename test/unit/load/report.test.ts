import { describe, expect, test } from 'bun:test';
import { DEFAULT_SCENARIO } from '@test/load/config';
import { renderReport } from '@test/load/report';
import { summarize } from '@test/load/stats';
import type { EnvironmentInfo, ScenarioResult } from '@test/load/types';

const environment: EnvironmentInfo = {
  commit: 'abc1234',
  branch: 'feat/load-test',
  startedAt: '2026-10-02T20:00:00.000Z',
  os: 'darwin 25.0.0 arm64',
  cpu: 'Apple M2',
  cpus: 8,
  memoryGb: 16,
  bun: '1.3.14',
  docker: '29.8.1',
  dockerCpus: 8,
  dockerMemoryGb: 8,
  postgres: 'postgres:18.6-alpine',
  ministack: 'ministackorg/ministack:1.5.20',
};

const result: ScenarioResult = {
  config: { ...DEFAULT_SCENARIO, name: 'http-sustained' },
  measuredSeconds: 10,
  http: {
    offered: 1000,
    completed: 998,
    outcomes: { ok: 990, unavailable: 8, timeout: 0, dropped: 2 },
    latency: summarize([1.25, 2.5, 3.75, 40]),
    throughput: 99,
    timeline: [],
  },
  server: {
    transactions: [{ channel: 'http', status: 'PROCESSED', count: 990 }],
    replays: 0,
    conflicts: 0,
    inboxDuplicates: 0,
    dbRetries: 0,
    lockTimeouts: 8,
    versionConflicts: 0,
    sqsRetries: 0,
    deadLettered: 0,
    lockWait: { p50: 0.0005, p95: 0.004, p99: 0.02 },
    processing: {},
    outboxDelay: { p95: 0.6 },
    maxOutboxAgeSeconds: 1,
    maxOutboxPending: 40,
    maxConnections: 12,
  },
  consistency: {
    wallets: 201,
    violations: [],
    drained: true,
    drainSeconds: 2,
    dlqDepth: 0,
    unpublished: 0,
    pendingReferences: 0,
  },
  generator: { cpuPercent: 37.5 },
};

describe('renderReport', () => {
  const markdown = renderReport(environment, [result]);

  test('describes the environment the numbers came from', () => {
    expect(markdown).toContain('| Commit | `abc1234` (feat/load-test) |');
    expect(markdown).toContain('| CPU | Apple M2 (8 núcleos) |');
    expect(markdown).toContain('| Docker | 29.8.1 (8 CPUs, 8 GB) |');
  });

  test('summarizes each scenario with throughput, percentiles and errors', () => {
    expect(markdown).toContain(
      '| http-sustained | sustained | http | 1/1 | 200 (0%) | 99.0 | 2.5 | 40.0 | 40.0 | 10 | ok |',
    );
  });

  test('reports a scenario as inconsistent when the invariant breaks', () => {
    const broken = renderReport(environment, [
      {
        ...result,
        consistency: { ...result.consistency, violations: ['wallet w: x'] },
      },
    ]);

    expect(broken).toContain('| 10 | **1 violação** |');
    expect(broken).toContain('wallet w: x');
  });

  test('shows missing statistics as a dash', () => {
    expect(
      renderReport(environment, [
        { ...result, http: { ...result.http!, latency: summarize([]) } },
      ]),
    ).toContain('| — | — | — |');
  });

  test('adds a per-second timeline to spike and recovery scenarios', () => {
    const spike = renderReport(environment, [
      {
        ...result,
        config: { ...result.config, profile: 'spike' },
        http: {
          ...result.http!,
          timeline: [
            { second: 0, completed: 3, ok: 3, failed: 0, p50: 2, p99: 4 },
            { second: 1, completed: 2, ok: 1, failed: 1, p50: 9, p99: 30 },
          ],
        },
      },
    ]);

    expect(spike).toContain('| Segundo | OK | Falhas | p50 ms | p99 ms |');
    expect(spike).toContain('| 1 | 1 | 1 | 9.0 | 30.0 |');
    expect(markdown).not.toContain('| Segundo |');
  });

  test('never leaves two blank lines in a row', () => {
    const saturation = renderReport(environment, [
      {
        ...result,
        config: { ...result.config, profile: 'saturation' },
        http: undefined,
        steps: [
          {
            concurrency: 4,
            completed: 100,
            throughput: 50,
            errorRate: 0,
            latency: summarize([1, 2, 3]),
          },
        ],
      },
    ]);

    expect(saturation).not.toContain('\n\n\n');
  });
});
