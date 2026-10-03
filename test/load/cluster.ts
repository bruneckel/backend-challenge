import { mkdir } from 'node:fs/promises';
import { DeleteQueueCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { SQL } from 'bun';
import {
  type QueueUrls,
  ensureQueues,
} from '@messaging/infrastructure/sqs/queue-provisioning';
import { createSqsClient } from '@messaging/infrastructure/sqs/sqs-client';
import { migrateUp } from '@platform/database/migrator';
import { LOAD_DATABASE_URL, LOAD_SQS, ROOT } from './infra';

export interface Storage {
  readonly databaseName: string;
  readonly sql: SQL;
  readonly sqs: SQSClient;
  readonly queues: QueueUrls;
  readonly environment: Record<string, string>;
  dispose(keepData: boolean): Promise<void>;
}

export async function createStorage(
  id: string,
  template?: string,
): Promise<Storage> {
  const databaseName = `load_${id}`;
  const admin = new SQL(LOAD_DATABASE_URL);
  await admin.unsafe(
    template === undefined
      ? `create database ${databaseName}`
      : `create database ${databaseName} template ${template} strategy file_copy`,
  );
  await admin.close();
  const url = new URL(LOAD_DATABASE_URL);
  url.pathname = `/${databaseName}`;
  await migrateUp(url.toString());
  const sqs = createSqsClient(LOAD_SQS, { requestTimeoutMs: 10_000 });
  const names = {
    commands: `load-${id}-commands.fifo`,
    deadLetter: `load-${id}-commands-dlq.fifo`,
    events: `load-${id}-events.fifo`,
  };
  const queues = await ensureQueues(sqs, names, {
    maxReceiveCount: 10,
    visibilityTimeoutSeconds: 30,
  });
  const sql = new SQL({ url: url.toString(), max: 4 });
  return {
    databaseName,
    sql,
    sqs,
    queues,
    environment: {
      DATABASE_URL: url.toString(),
      AWS_ENDPOINT_URL: LOAD_SQS.endpoint,
      AWS_REGION: LOAD_SQS.region,
      AWS_ACCESS_KEY_ID: LOAD_SQS.accessKeyId,
      AWS_SECRET_ACCESS_KEY: LOAD_SQS.secretAccessKey,
      SQS_COMMANDS_QUEUE: names.commands,
      SQS_DEAD_LETTER_QUEUE: names.deadLetter,
      SQS_EVENTS_QUEUE: names.events,
    },
    async dispose(keepData) {
      await sql.close();
      if (!keepData) {
        await Promise.allSettled(
          Object.values(queues).map((QueueUrl) =>
            sqs.send(new DeleteQueueCommand({ QueueUrl })),
          ),
        );
        const cleanup = new SQL(LOAD_DATABASE_URL);
        await cleanup.unsafe(
          `drop database if exists ${databaseName} with (force)`,
        );
        await cleanup.close();
      }
      sqs.destroy();
    },
  };
}

export interface AppProcess {
  readonly name: string;
  readonly url: string;
  readonly logPath: string;
  stop(signal?: NodeJS.Signals): Promise<number>;
}

const running = new Set<AppProcess>();

function freePort(): number {
  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data() {} },
  });
  const { port } = listener;
  listener.stop(true);
  return port;
}

async function tail(path: string): Promise<string> {
  const text = await Bun.file(path)
    .text()
    .catch(() => '');
  return text.split('\n').slice(-15).join('\n');
}

export async function startApp(
  role: 'api' | 'worker',
  index: number,
  environment: Record<string, string>,
  logDir: string,
): Promise<AppProcess> {
  await mkdir(logDir, { recursive: true });
  const port = freePort();
  const name = `${role}-${index}`;
  const logPath = `${logDir}/${name}.log`;
  const child = Bun.spawn(['bun', `src/main.${role}.ts`], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...environment,
      PORT: String(port),
      INSTANCE_ID: name,
    },
    stdout: Bun.file(logPath),
    stderr: Bun.file(`${logDir}/${name}.err.log`),
  });
  let exitCode: number | undefined;
  void child.exited.then((code) => {
    exitCode = code;
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (exitCode !== undefined) {
      throw new Error(
        `${name} exited with ${exitCode}:\n${await tail(logPath)}`,
      );
    }
    const ready = await fetch(`${url}/health/ready`, {
      signal: AbortSignal.timeout(1000),
    })
      .then((response) => response.status === 200)
      .catch(() => false);
    if (ready) {
      break;
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`${name} did not become ready:\n${await tail(logPath)}`);
    }
    await Bun.sleep(100);
  }
  const app: AppProcess = {
    name,
    url,
    logPath,
    async stop(signal = 'SIGTERM') {
      child.kill(signal);
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      const code = await child.exited;
      clearTimeout(timer);
      running.delete(app);
      return code;
    },
  };
  running.add(app);
  return app;
}

export async function stopAll(
  signal: NodeJS.Signals = 'SIGTERM',
): Promise<void> {
  await Promise.allSettled([...running].map((app) => app.stop(signal)));
}
