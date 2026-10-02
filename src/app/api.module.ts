import { type DynamicModule, Module } from '@nestjs/common';
import { messagingEntities } from '@messaging/infrastructure/persistence/messaging-entities';
import { HealthModule } from '@observability/health/health.module';
import { MetricsModule } from '@observability/metrics/metrics.module';
import type { PrometheusMetrics } from '@observability/metrics/prometheus-metrics';
import type { AppConfig } from '@platform/config/app-config';
import { ShutdownLogger } from '@platform/lifecycle/shutdown-logger';
import { PlatformModule } from '@platform/platform.module';
import type { Logger } from '@shared/application/logger';
import { WalletHttpModule } from '@wallet/infrastructure/http/wallet-http.module';
import { walletEntities } from '@wallet/infrastructure/persistence/wallet-entities';

export interface CompositionOptions {
  config: AppConfig;
  logger: Logger;
  metrics: PrometheusMetrics;
}

@Module({})
export class ApiModule {
  static forRoot(options: CompositionOptions): DynamicModule {
    return {
      module: ApiModule,
      imports: [
        PlatformModule.forRoot({
          ...options,
          entities: [...walletEntities, ...messagingEntities],
        }),
        HealthModule,
        MetricsModule,
        WalletHttpModule,
      ],
      providers: [ShutdownLogger],
    };
  }
}
