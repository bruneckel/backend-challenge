import { describe, expect, test } from 'bun:test';
import { waitUntil } from '@test/support/async';

const PROMETHEUS = 'http://localhost:9090';
const GRAFANA = 'http://localhost:3001';
const START = 'docker compose --profile observability up -d --wait';

async function get(url: string): Promise<Response> {
  return fetch(url).catch((error: unknown) => {
    throw new Error(`${url} is not reachable; start the stack with ${START}`, {
      cause: error,
    });
  });
}

interface Target {
  labels: { job: string };
  scrapeUrl: string;
  health: string;
}

async function wageringTargets(): Promise<Target[]> {
  const response = await get(`${PROMETHEUS}/api/v1/targets?state=active`);
  const body = (await response.json()) as {
    data: { activeTargets: Target[] };
  };
  return body.data.activeTargets.filter(
    (target) => target.labels.job === 'wagering',
  );
}

async function query(expression: string): Promise<Record<string, string>[]> {
  const response = await get(
    `${PROMETHEUS}/api/v1/query?query=${encodeURIComponent(expression)}`,
  );
  const body = (await response.json()) as {
    data: { result: { metric: Record<string, string> }[] };
  };
  return body.data.result.map((series) => series.metric);
}

describe('observability profile', () => {
  test('Prometheus scrapes the api and the worker with a token from Keycloak', async () => {
    await waitUntil(
      async () => {
        const targets = await wageringTargets();
        return (
          targets.length === 2 &&
          targets.every((target) => target.health === 'up')
        );
      },
      {
        timeoutMs: 60_000,
        intervalMs: 1000,
        description: 'the api and the worker targets to be up',
      },
    );

    const targets = await wageringTargets();
    expect(targets.map((target) => target.scrapeUrl).sort()).toEqual([
      'http://api:3000/metrics',
      'http://worker:3000/metrics',
    ]);
    const roles = await query('count by (role) (inbox_duplicates_total)');
    expect(roles.map((series) => series.role).sort()).toEqual([
      'api',
      'worker',
    ]);
  });

  test('Grafana serves the provisioned dashboard to anonymous viewers', async () => {
    const health = await get(`${GRAFANA}/api/health`);
    expect(health.status).toBe(200);

    const response = await get(
      `${GRAFANA}/api/dashboards/uid/wagering-processor`,
    );

    expect(response.status).toBe(200);
    const { dashboard } = (await response.json()) as {
      dashboard: { title: string };
    };
    expect(dashboard.title).toBe('Wagering Processor');
  });
});
