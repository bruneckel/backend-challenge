import { DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { createSqsClient } from '@messaging/infrastructure/sqs/sqs-client';
import type { AppConfig } from '@platform/config/app-config';
import { APP_CONFIG } from '@platform/tokens';
import { CONSUMER_SQS_CLIENT } from '@wallet/infrastructure/messaging/wager-consumer.module';
import { log, startWorkerWith } from './start-worker-with';

await startWorkerWith((builder) =>
  builder.overrideProvider(CONSUMER_SQS_CLIENT).useFactory({
    factory: (config: AppConfig) => {
      const client = createSqsClient(config.sqs, {
        requestTimeoutMs: config.consumer.receiveTimeoutMs,
      });
      const send = client.send.bind(client);
      client.send = ((command: unknown, options?: unknown) => {
        if (command instanceof DeleteMessageCommand) {
          log({ level: 'info', msg: 'committed, crashing before the ack' });
          process.kill(process.pid, 'SIGKILL');
        }
        return (
          send as (command: unknown, options?: unknown) => Promise<unknown>
        )(command, options);
      }) as typeof client.send;
      return client;
    },
    inject: [APP_CONFIG],
  }),
);
