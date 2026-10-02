import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { WorkerModule } from '@app/worker.module';
import { configureHttpApplication } from '@app/http-application';
import type { EventPublisher } from '@messaging/application/ports/event-publisher';
import { EVENT_PUBLISHER } from '@messaging/infrastructure/outbox-publisher.module';
import { lazyQueueUrl } from '@messaging/infrastructure/sqs/queue-provisioning';
import { createSqsClient } from '@messaging/infrastructure/sqs/sqs-client';
import { SqsEventPublisher } from '@messaging/infrastructure/sqs/sqs-event-publisher';
import { Test } from '@nestjs/testing';
import { type AppConfig, loadConfig } from '@platform/config/app-config';
import { APP_CONFIG } from '@platform/tokens';

const log = (entry: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify(entry)}\n`);

const config = loadConfig(process.env);
const moduleRef = await Test.createTestingModule({
  imports: [WorkerModule.forRoot(config)],
})
  .overrideProvider(EVENT_PUBLISHER)
  .useFactory({
    factory: (settings: AppConfig): EventPublisher => {
      const client = createSqsClient(settings.sqs, {
        requestTimeoutMs: settings.sqs.publishTimeoutMs,
      });
      const real = new SqsEventPublisher(
        client,
        lazyQueueUrl(client, settings.sqs.eventsQueue),
      );
      return {
        async publish(messages) {
          const report = await real.publish(messages);
          log({
            level: 'info',
            msg: 'published before crash',
            published: report.published,
          });
          process.kill(process.pid, 'SIGKILL');
          return report;
        },
      };
    },
    inject: [APP_CONFIG],
  })
  .compile();
const app = configureHttpApplication(
  moduleRef.createNestApplication({ logger: ['error', 'warn'] }),
);
await app.listen(0, '127.0.0.1');
log({
  level: 'info',
  msg: 'worker listening',
  port: (app.getHttpServer().address() as AddressInfo).port,
});
