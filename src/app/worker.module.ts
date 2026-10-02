import { type DynamicModule, Module } from '@nestjs/common';
import { OutboxPublisherModule } from '@messaging/infrastructure/outbox-publisher.module';
import { messagingEntities } from '@messaging/infrastructure/persistence/messaging-entities';
import { HealthModule } from '@observability/health/health.module';
import { BacklogSamplerModule } from '@observability/metrics/backlog-sampler.module';
import { MetricsModule } from '@observability/metrics/metrics.module';
import { ShutdownLogger } from '@platform/lifecycle/shutdown-logger';
import { PlatformModule } from '@platform/platform.module';
import { WagerConsumerModule } from '@wallet/infrastructure/messaging/wager-consumer.module';
import { walletEntities } from '@wallet/infrastructure/persistence/wallet-entities';
import { PendingReferenceSchedulerModule } from '@wallet/infrastructure/scheduling/pending-reference-scheduler.module';
import type { CompositionOptions } from './api.module';

@Module({})
export class WorkerModule {
  static forRoot(options: CompositionOptions): DynamicModule {
    const { worker } = options.config;
    return {
      module: WorkerModule,
      imports: [
        PlatformModule.forRoot({
          ...options,
          entities: [...walletEntities, ...messagingEntities],
        }),
        HealthModule,
        MetricsModule,
        BacklogSamplerModule,
        ...(worker.publisherEnabled ? [OutboxPublisherModule] : []),
        ...(worker.consumerEnabled ? [WagerConsumerModule] : []),
        ...(worker.schedulerEnabled ? [PendingReferenceSchedulerModule] : []),
      ],
      providers: [ShutdownLogger],
    };
  }
}
