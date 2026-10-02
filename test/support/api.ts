import type { INestApplication } from '@nestjs/common';
import { createApiApplication } from '@app/api-application';
import { loadConfig } from '@platform/config/app-config';
import { type Logger, silentLogger } from '@shared/application/logger';
import { type TestDatabase, createMigratedDatabase } from './database';
import { createTestQueues, createTestSqsClient } from './sqs';

export interface ApiResponse {
  status: number;
  headers: Headers;
  body: any;
}

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
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

export async function requestApi(
  baseUrl: string,
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<ApiResponse> {
  const { body, headers = {} } = options;
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
