import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { lazyQueueUrl } from '@messaging/infrastructure/sqs/queue-provisioning';
import { createSqsClient } from '@messaging/infrastructure/sqs/sqs-client';
import type { AppConfig } from '@platform/config/app-config';
import { PollingLoop } from '@platform/lifecycle/polling-loop';
import { APP_CONFIG, LOGGER, METRICS } from '@platform/tokens';
import type { Logger } from '@shared/application/logger';
import type { Metrics } from '@shared/application/metrics';
import { ExponentialBackoff } from '@shared/domain/exponential-backoff';

const BACKLOG_SQL = `
  select
    (select count(*)::int from outbox_messages where published_at is null) as outbox_pending,
    (select coalesce(extract(epoch from now() - min(occurred_at)), 0)::float8
       from outbox_messages where published_at is null) as outbox_oldest_age,
    (select count(*)::int from wager_transactions where status = 'PENDING_REFERENCE') as pending_references`;

interface BacklogRow {
  outbox_pending: number;
  outbox_oldest_age: number;
  pending_references: number;
}

@Injectable()
export class BacklogSampler
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly client: SQSClient;
  private readonly deadLetterQueueUrl: () => Promise<string>;
  private readonly loop: PollingLoop;

  constructor(
    private readonly orm: MikroORM,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.client = createSqsClient(config.sqs, { requestTimeoutMs: 2000 });
    this.deadLetterQueueUrl = lazyQueueUrl(
      this.client,
      config.sqs.deadLetterQueue,
    );
    this.loop = new PollingLoop({
      step: async () => {
        await this.sample();
        return false;
      },
      idleDelayMs: config.observability.metricsSampleIntervalMs,
      errorBackoff: ExponentialBackoff.create({ baseMs: 1000, maxMs: 30_000 }),
    });
  }

  async sample(): Promise<void> {
    await Promise.all([this.sampleDatabase(), this.sampleDeadLetterQueue()]);
  }

  onApplicationBootstrap(): void {
    this.loop.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop();
    this.client.destroy();
  }

  private async sampleDatabase(): Promise<void> {
    try {
      const [row] = await this.orm.em.fork().execute<BacklogRow[]>(BACKLOG_SQL);
      if (row !== undefined) {
        this.metrics.set('outbox_pending_events', row.outbox_pending);
        this.metrics.set(
          'outbox_oldest_pending_age_seconds',
          row.outbox_oldest_age,
        );
        this.metrics.set(
          'pending_reference_transactions',
          row.pending_references,
        );
      }
    } catch (error) {
      this.logger.warn('backlog sample from the database failed', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  private async sampleDeadLetterQueue(): Promise<void> {
    try {
      const { Attributes } = await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: await this.deadLetterQueueUrl(),
          AttributeNames: ['ApproximateNumberOfMessages'],
        }),
      );
      this.metrics.set(
        'sqs_dlq_approximate_messages',
        Number(Attributes?.ApproximateNumberOfMessages ?? 0),
      );
    } catch (error) {
      this.logger.warn('dead-letter queue sample failed', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }
}

@Module({ providers: [BacklogSampler] })
export class BacklogSamplerModule {}
