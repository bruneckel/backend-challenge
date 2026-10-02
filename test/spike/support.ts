import { SQSClient } from '@aws-sdk/client-sqs';

export const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://wagering:wagering@localhost:5432/wagering';

export const SQS_ENDPOINT =
  process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';

export function createSqsClient(): SQSClient {
  return new SQSClient({
    endpoint: SQS_ENDPOINT,
    region: process.env.AWS_REGION ?? 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
}

export function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
