import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { migrations as registeredMigrations } from '@platform/database/migrations';
import { type TestDatabase, createTestDatabase } from '@test/support/database';
import { SQS_SETTINGS, createTestSqsClient } from '@test/support/sqs';

let database: TestDatabase;
let sqs: SQSClient;
const prefix = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const names = {
  SQS_COMMANDS_QUEUE: `${prefix}-commands.fifo`,
  SQS_DEAD_LETTER_QUEUE: `${prefix}-commands-dlq.fifo`,
  SQS_EVENTS_QUEUE: `${prefix}-events.fifo`,
};

beforeAll(async () => {
  database = await createTestDatabase();
  sqs = createTestSqsClient();
});

afterAll(async () => {
  for (const name of Object.values(names)) {
    const url = await sqs
      .send(new GetQueueUrlCommand({ QueueName: name }))
      .then((result) => result.QueueUrl)
      .catch(() => undefined);
    if (url !== undefined) {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
    }
  }
  sqs.destroy();
  await database.drop();
});

async function runBootstrap(): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn(['bun', 'src/main.bootstrap.ts'], {
    env: {
      ...process.env,
      DATABASE_URL: database.url,
      AWS_ENDPOINT_URL: SQS_SETTINGS.endpoint,
      ...names,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, output: stdout + stderr };
}

describe('bootstrap', () => {
  test('applies the migrations and creates the three FIFO queues with the redrive policy', async () => {
    const result = await runBootstrap();

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('"msg":"bootstrap complete"');
    const [migrations] = await database.sql`
      select count(*)::int as count from mikro_orm_migrations`;
    expect(migrations.count).toBe(registeredMigrations.length);
    const { QueueUrl } = await sqs.send(
      new GetQueueUrlCommand({ QueueName: names.SQS_COMMANDS_QUEUE }),
    );
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl,
        AttributeNames: ['FifoQueue', 'RedrivePolicy', 'VisibilityTimeout'],
      }),
    );
    expect(Attributes?.FifoQueue).toBe('true');
    expect(Attributes?.VisibilityTimeout).toBe('30');
    expect(JSON.parse(Attributes?.RedrivePolicy ?? '{}')).toMatchObject({
      maxReceiveCount: 10,
    });
    for (const name of [names.SQS_DEAD_LETTER_QUEUE, names.SQS_EVENTS_QUEUE]) {
      const url = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
      expect(url.QueueUrl).toBeDefined();
    }
  });

  test('can run again without changing anything', async () => {
    const result = await runBootstrap();

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('"appliedMigrations":0');
  });
});
