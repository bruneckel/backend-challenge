import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ReadinessState } from '@observability/health/readiness-state';
import { type ApiHarness, startApi } from '@test/support/api';

let api: ApiHarness;

beforeAll(async () => {
  api = await startApi();
});

afterAll(async () => {
  await api.close();
});

describe('health endpoints', () => {
  test('GET /health/live answers 200 while the process runs', async () => {
    const response = await api.request('GET', '/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  test('GET /health/ready answers 200 when the database answers', async () => {
    const response = await api.request('GET', '/health/ready');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ready', checks: { database: 'up' } });
  });

  test('GET /health/ready answers 503 once shutdown has started', async () => {
    api.app.get(ReadinessState).beginShutdown();

    const response = await api.request('GET', '/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'shutting_down' });
  });
});
