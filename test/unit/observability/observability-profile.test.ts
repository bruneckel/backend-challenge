import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { PrometheusMetrics } from '@observability/metrics/prometheus-metrics';

const ROOT = resolve(import.meta.dir, '../../..');
const METRIC_REFERENCE = /([a-z_][a-z0-9_]*)\s*[{[]/g;

interface Panel {
  type: string;
  title?: string;
  targets?: { expr?: string }[];
  panels?: Panel[];
}

interface ScrapeConfig {
  job_name: string;
  honor_labels?: boolean;
  oauth2?: { client_id: string; client_secret: string; token_url: string };
  static_configs: { targets: string[] }[];
}

const dashboard = (): Promise<{ uid: string; panels: Panel[] }> =>
  Bun.file(
    resolve(ROOT, 'observability/grafana/dashboards/wagering.json'),
  ).json();

function expressionsOf(panels: readonly Panel[]): string[] {
  return panels.flatMap((panel) => [
    ...(panel.targets ?? []).map((target) => target.expr ?? ''),
    ...expressionsOf(panel.panels ?? []),
  ]);
}

const metricsIn = (expression: string) =>
  [...expression.matchAll(METRIC_REFERENCE)].map((match) => match[1]!);

async function exportedFamilies(): Promise<Map<string, string[]>> {
  const metrics = new PrometheusMetrics({ role: 'api', instance: 'test' });
  const families = await metrics.registry.getMetricsAsJSON();
  return new Map(
    families.map((family) => [
      family.name,
      String(family.type) === 'histogram'
        ? ['_bucket', '_sum', '_count'].map((suffix) => family.name + suffix)
        : [family.name],
    ]),
  );
}

describe('observability profile', () => {
  test('every dashboard query reads metrics the application exports', async () => {
    const exported = new Set([...(await exportedFamilies()).values()].flat());
    const expressions = expressionsOf((await dashboard()).panels);

    expect(expressions.length).toBeGreaterThan(0);
    for (const expression of expressions) {
      const metrics = metricsIn(expression);
      expect(metrics.length, expression).toBeGreaterThan(0);
      expect(
        metrics.filter((metric) => !exported.has(metric)),
        expression,
      ).toEqual([]);
    }
  });

  test('every metric the application exports has a panel', async () => {
    const used = new Set(
      expressionsOf((await dashboard()).panels).flatMap(metricsIn),
    );

    const missing = [...(await exportedFamilies())]
      .filter(([, series]) => !series.some((name) => used.has(name)))
      .map(([family]) => family);

    expect(missing).toEqual([]);
  });

  test('Prometheus scrapes the api and the worker with the metrics client of the realm', async () => {
    const config = Bun.YAML.parse(
      await Bun.file(
        resolve(ROOT, 'observability/prometheus/prometheus.yml'),
      ).text(),
    ) as { scrape_configs: ScrapeConfig[] };
    const realm = await Bun.file(
      resolve(ROOT, 'keycloak/wagering-realm.json'),
    ).json();
    const metricsClient = realm.clients.find(
      (client: { clientId: string }) => client.clientId === 'wagering-metrics',
    );

    const [job] = config.scrape_configs;

    expect(config.scrape_configs).toHaveLength(1);
    expect(job?.honor_labels).toBe(true);
    expect(job?.static_configs.flatMap((entry) => entry.targets)).toEqual([
      'api:3000',
      'worker:3000',
    ]);
    expect(job?.oauth2).toEqual({
      client_id: 'wagering-metrics',
      client_secret: metricsClient.secret,
      token_url:
        'http://keycloak:8080/realms/wagering/protocol/openid-connect/token',
    });
  });
});
