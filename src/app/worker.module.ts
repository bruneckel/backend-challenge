import { type DynamicModule, Module } from '@nestjs/common';
import { OutboxPublisherModule } from '@messaging/infrastructure/outbox-publisher.module';
import { messagingEntities } from '@messaging/infrastructure/persistence/messaging-entities';
import { HealthModule } from '@observability/health/health.module';
import type { AppConfig } from '@platform/config/app-config';
import { ShutdownLogger } from '@platform/lifecycle/shutdown-logger';
import { PlatformModule } from '@platform/platform.module';
import { WagerConsumerModule } from '@wallet/infrastructure/messaging/wager-consumer.module';
import { walletEntities } from '@wallet/infrastructure/persistence/wallet-entities';

@Module({})
export class WorkerModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        PlatformModule.forRoot({ config, entities: [...walletEntities, ...messagingEntities] }),
        HealthModule,
        ...(config.worker.publisherEnabled ? [OutboxPublisherModule] : []),
        ...(config.worker.consumerEnabled ? [WagerConsumerModule] : []),
      ],
      providers: [ShutdownLogger],
    };
  }
}
