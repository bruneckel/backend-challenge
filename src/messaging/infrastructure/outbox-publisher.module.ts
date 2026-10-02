import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { EventPublisher } from '@messaging/application/ports/event-publisher';
import type { OutboxScope } from '@messaging/application/ports/outbox-scope';
import { PublishOutboxBatch } from '@messaging/application/publish-outbox-batch';
import type { AppConfig } from '@platform/config/app-config';
import { MikroOrmUnitOfWork } from '@platform/database/mikro-orm-unit-of-work';
import { PollingLoop } from '@platform/lifecycle/polling-loop';
import { APP_CONFIG, CLOCK } from '@platform/tokens';
import type { Clock } from '@shared/application/clock';
import type { UnitOfWork } from '@shared/application/unit-of-work';
import { ExponentialBackoff } from '@shared/domain/exponential-backoff';
import { createOutboxScope } from './persistence/outbox-scope';
import { lazyQueueUrl } from './sqs/queue-provisioning';
import { createSqsClient } from './sqs/sqs-client';
import { SqsEventPublisher } from './sqs/sqs-event-publisher';

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');
export const OUTBOX_UNIT_OF_WORK = Symbol('OUTBOX_UNIT_OF_WORK');
const PUBLISHER_SQS_CLIENT = Symbol('PUBLISHER_SQS_CLIENT');

@Injectable()
class PublisherClientLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PUBLISHER_SQS_CLIENT) private readonly client: SQSClient) {}

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}

@Injectable()
export class OutboxPublisherRunner implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: PollingLoop;

  constructor(publishBatch: PublishOutboxBatch, @Inject(APP_CONFIG) config: AppConfig) {
    this.loop = new PollingLoop({
      step: async () => (await publishBatch.execute()).claimed === config.outbox.batchSize,
      idleDelayMs: config.outbox.pollIntervalMs,
      errorBackoff: ExponentialBackoff.create({ baseMs: 500, maxMs: 30_000 }),
      onError: (error, consecutiveFailures) =>
        process.stderr.write(
          `${JSON.stringify({
            level: 'error',
            msg: 'outbox publisher step failed',
            errorName: error instanceof Error ? error.name : typeof error,
            consecutiveFailures,
          })}\n`,
        ),
    });
  }

  onApplicationBootstrap(): void {
    this.loop.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }
}

@Module({
  providers: [
    {
      provide: PUBLISHER_SQS_CLIENT,
      useFactory: (config: AppConfig) => createSqsClient(config.sqs, { requestTimeoutMs: config.sqs.publishTimeoutMs }),
      inject: [APP_CONFIG],
    },
    PublisherClientLifecycle,
    {
      provide: EVENT_PUBLISHER,
      useFactory: (client: SQSClient, config: AppConfig) =>
        new SqsEventPublisher(client, lazyQueueUrl(client, config.sqs.eventsQueue)),
      inject: [PUBLISHER_SQS_CLIENT, APP_CONFIG],
    },
    {
      provide: OUTBOX_UNIT_OF_WORK,
      useFactory: (orm: MikroORM, config: AppConfig) =>
        new MikroOrmUnitOfWork(orm, createOutboxScope, { lockTimeoutMs: config.database.lockTimeoutMs }),
      inject: [MikroORM, APP_CONFIG],
    },
    {
      provide: PublishOutboxBatch,
      useFactory: (unitOfWork: UnitOfWork<OutboxScope>, publisher: EventPublisher, clock: Clock, config: AppConfig) =>
        new PublishOutboxBatch({
          unitOfWork,
          publisher,
          clock,
          retryBackoff: ExponentialBackoff.create({ baseMs: config.outbox.retryBaseMs, maxMs: config.outbox.retryMaxMs }),
          batchSize: config.outbox.batchSize,
        }),
      inject: [OUTBOX_UNIT_OF_WORK, EVENT_PUBLISHER, CLOCK, APP_CONFIG],
    },
    OutboxPublisherRunner,
  ],
})
export class OutboxPublisherModule {}
