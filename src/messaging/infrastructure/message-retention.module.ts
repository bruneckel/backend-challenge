import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import type { RetentionScope } from '@messaging/application/ports/retention-scope';
import { PurgeExpiredMessages } from '@messaging/application/purge-expired-messages';
import type { AppConfig } from '@platform/config/app-config';
import { MikroOrmUnitOfWork } from '@platform/database/mikro-orm-unit-of-work';
import { PollingLoop } from '@platform/lifecycle/polling-loop';
import { APP_CONFIG, CLOCK, LOGGER, METRICS } from '@platform/tokens';
import type { Clock } from '@shared/application/clock';
import type { Logger } from '@shared/application/logger';
import type { Metrics } from '@shared/application/metrics';
import type { UnitOfWork } from '@shared/application/unit-of-work';
import { ExponentialBackoff } from '@shared/domain/exponential-backoff';
import { createRetentionScope } from './persistence/retention-scope';

export const RETENTION_UNIT_OF_WORK = Symbol('RETENTION_UNIT_OF_WORK');

@Injectable()
export class MessageRetentionRunner
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly loop: PollingLoop;

  constructor(
    purge: PurgeExpiredMessages,
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.loop = new PollingLoop({
      step: async () => {
        const { outbox, inbox } = await purge.execute();
        return (
          outbox === config.retention.batchSize ||
          inbox === config.retention.batchSize
        );
      },
      idleDelayMs: config.retention.intervalMs,
      busyDelayMs: config.retention.batchPauseMs,
      errorBackoff: ExponentialBackoff.create({ baseMs: 1000, maxMs: 60_000 }),
      onError: (error, consecutiveFailures) =>
        logger.error('message retention step failed', {
          errorName: error instanceof Error ? error.name : typeof error,
          consecutiveFailures,
        }),
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
      provide: RETENTION_UNIT_OF_WORK,
      useFactory: (orm: MikroORM, config: AppConfig, metrics: Metrics) =>
        new MikroOrmUnitOfWork(orm, createRetentionScope, {
          lockTimeoutMs: config.database.lockTimeoutMs,
          metrics,
        }),
      inject: [MikroORM, APP_CONFIG, METRICS],
    },
    {
      provide: PurgeExpiredMessages,
      useFactory: (
        unitOfWork: UnitOfWork<RetentionScope>,
        clock: Clock,
        metrics: Metrics,
        config: AppConfig,
      ) =>
        new PurgeExpiredMessages({
          unitOfWork,
          clock,
          metrics,
          settings: {
            outboxRetentionHours: config.retention.outboxHours,
            inboxRetentionHours: config.retention.inboxHours,
            batchSize: config.retention.batchSize,
          },
        }),
      inject: [RETENTION_UNIT_OF_WORK, CLOCK, METRICS, APP_CONFIG],
    },
    MessageRetentionRunner,
  ],
})
export class MessageRetentionModule {}
