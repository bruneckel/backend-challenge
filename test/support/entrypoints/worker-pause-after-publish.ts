import type { EventPublisher } from '@messaging/application/ports/event-publisher';
import { EVENT_PUBLISHER } from '@messaging/infrastructure/outbox-publisher.module';
import { lazyQueueUrl } from '@messaging/infrastructure/sqs/queue-provisioning';
import { createSqsClient } from '@messaging/infrastructure/sqs/sqs-client';
import { SqsEventPublisher } from '@messaging/infrastructure/sqs/sqs-event-publisher';
import type { AppConfig } from '@platform/config/app-config';
import { APP_CONFIG } from '@platform/tokens';
import { pause, startWorkerWith } from './start-worker-with';

await startWorkerWith((builder) =>
  builder.overrideProvider(EVENT_PUBLISHER).useFactory({
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
          await pause('published, paused before the commit');
          return report;
        },
      };
    },
    inject: [APP_CONFIG],
  }),
);
