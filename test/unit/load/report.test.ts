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
    publishedEvents: 1980,
  },
  consistency: {
    wallets: 201,
    violations: [],
    drained: true,
    drainSeconds: 2,
    dlqDepth: 0,
    unpublished: 0,
    pendingReferences: 0,
    outboxEvents: 1980,
    eventsDelivered: 1980,
    eventsQueued: 0,
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

  test('reports every outbox event delivered to the downstream consumer', () => {
    expect(markdown).toContain('eventos entregues 1980 de 1980');
  });

  test('flags events that never reached the downstream consumer', () => {
    const missing = renderReport(environment, [
      {
        ...result,
        consistency: { ...result.consistency, eventsDelivered: 1900 },
      },
    ]);

    expect(missing).toContain('| 10 | **80 eventos não entregues** |');
  });

  test('accepts events still waiting in the queue as delivered later, not lost', () => {
    const queued = renderReport(environment, [
      {
        ...result,
        consistency: {
          ...result.consistency,
          eventsDelivered: 1900,
          eventsQueued: 80,
        },
      },
    ]);

    expect(queued).toContain('| 10 | ok |');
    expect(queued).toContain(
      'eventos entregues 1900 de 1980 (80 ainda na fila)',
    );
  });

  test('describes the seeded database a scenario ran on', () => {
    const seeded = renderReport(environment, [
      {
        ...result,
        config: {
          ...result.config,
          seedWallets: 1_000_000,
          seedOperations: 4,
          seedHotEntries: 0,
          seedEvents: false,
        },
      },
    ]);

    expect(seeded).toContain(
      'Base semeada: 1000000 wallets com 4 operações cada; eventos publicados na outbox: não. O tráfego sorteia 200 dessas wallets.',
    );
  });

  test('summarizes the wallet streams of a scenario', () => {
    const streamed = renderReport(environment, [
      {
        ...result,
        streams: {
          subscribers: 100,
          replicas: 3,
          entries: 5000,
          latency: summarize([120, 250, 480]),
          gaps: 0,
          repeats: 0,
          behind: 0,
          closedEarly: 0,
        },
      },
    ]);

    expect(streamed).toContain('| 10 | ok |');
    expect(streamed).toContain(
      '- Streams: 100 assinaturas em 3 réplicas; 5000 lançamentos entregues; lacunas 0; repetidos 0; faltando ao fim 0; encerrados antes do fim 0.',
    );
    expect(streamed).toContain(
      '- Entrega pelo stream (lançamento → cliente): 3 amostras;',
    );
  });

  test('flags a stream that skipped, repeated or missed entries', () => {
    const broken = renderReport(environment, [
      {
        ...result,
        streams: {
          subscribers: 1,
          replicas: 1,
          entries: 10,
          latency: summarize([1]),
          gaps: 1,
          repeats: 0,
          behind: 0,
          closedEarly: 0,
        },
      },
    ]);

    expect(broken).toContain('| 10 | **stream com falhas** |');
  });

  test('summarizes a publish scenario by the events published per second', () => {
    const publish = renderReport(environment, [
      {
        ...result,
        config: { ...result.config, name: 'outbox', profile: 'publish' },
        http: undefined,
        publish: { operations: 500, events: 1000, seconds: 2, throughput: 500 },
      },
    ]);

    expect(publish).toContain(
      '| outbox | publish | outbox | 1/1 | 200 (0%) | 500.0 |',
    );
    expect(publish).toContain(
      '- Outbox: 500 operações geraram 1000 eventos, publicados em 2.0 s (500.0 eventos/s).',
    );
  });
});
