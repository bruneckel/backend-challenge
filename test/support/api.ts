import type { INestApplication } from '@nestjs/common';
import { createApiApplication } from '@app/api-application';
import { loadConfig } from '@platform/config/app-config';
import { type Logger, silentLogger } from '@shared/application/logger';
import { type TestDatabase, createMigratedDatabase } from './database';
import { METRICS_READER, OPERATOR, testIdentity } from './identity';
import { createTestQueues, createTestSqsClient } from './sqs';

export interface ApiResponse {
  status: number;
  headers: Headers;
  body: any;
}

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  token?: string | null;
}

export interface ApiHarness {
  readonly database: TestDatabase;
  readonly app: INestApplication;
  readonly baseUrl: string;
  request(
    method: string,
    path: string,
    options?: RequestOptions,
  ): Promise<ApiResponse>;
  close(): Promise<void>;
}

function providerOf(path: string, body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null) {
    const { providerId } = body as { providerId?: unknown };
    if (typeof providerId === 'string' && providerId !== '') {
      return providerId;
    }
  }
  const match = /^\/providers\/([^/]+)\//.exec(path);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

async function authorizationFor(
  path: string,
  options: RequestOptions,
): Promise<Record<string, string>> {
  const { body, headers = {}, token } = options;
  if (
    token === null ||
    Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')
  ) {
    return {};
  }
  const bearer =
    token ??
    (await (
      await testIdentity()
    ).token({
      providerId: providerOf(path, body),
      roles: [OPERATOR, METRICS_READER],
    }));
  return { authorization: `Bearer ${bearer}` };
}

export async function requestApi(
  baseUrl: string,
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<ApiResponse> {
  const { body } = options;
  const headers = {
    ...(await authorizationFor(path, options)),
    ...options.headers,
  };
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers:
      body === undefined
        ? headers
        : { 'content-type': 'application/json', ...headers },
    body:
      body === undefined
        ? undefined
        : typeof body === 'string'
          ? body
          : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text === '' ? undefined : JSON.parse(text),
  };
}

export async function startApi(
  environment: Record<string, string> = {},
  logger: Logger = silentLogger,
): Promise<ApiHarness> {
  const database = await createMigratedDatabase();
  const sqs = createTestSqsClient();
  const queues = await createTestQueues(sqs);
  const config = loadConfig({
    DATABASE_URL: database.url,
    PORT: '0',
    ...queues.environment,
    ...(await testIdentity()).environment,
    ...environment,
  });
  const app = await createApiApplication(config, { logger });
  await app.listen(0, '127.0.0.1');
  const baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  return {
    database,
    app,
    baseUrl,
    request: (method, path, options) =>
      requestApi(baseUrl, method, path, options),
    async close() {
      await app.close();
      await queues.delete();
      sqs.destroy();
      await database.drop();
    },
  };
}
