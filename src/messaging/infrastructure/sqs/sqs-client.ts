import { SQSClient } from '@aws-sdk/client-sqs';

export interface SqsConnectionSettings {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SqsClientOptions {
  requestTimeoutMs?: number;
  connectionTimeoutMs?: number;
  maxAttempts?: number;
}

export function createSqsClient(
  settings: SqsConnectionSettings,
  options: SqsClientOptions = {},
): SQSClient {
  return new SQSClient({
    endpoint: settings.endpoint,
    region: settings.region,
    credentials: {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
    },
    maxAttempts: options.maxAttempts ?? 2,
    requestHandler: {
      requestTimeout: options.requestTimeoutMs ?? 5000,
      connectionTimeout: options.connectionTimeoutMs ?? 1000,
      throwOnRequestTimeout: true,
    },
  });
}
