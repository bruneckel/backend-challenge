import { Module } from '@nestjs/common';
import type { AppConfig } from '@platform/config/app-config';
import { APP_CONFIG, LOGGER, METRICS } from '@platform/tokens';
import type { Logger } from '@shared/application/logger';
import type { Metrics } from '@shared/application/metrics';
import { WalletQueries } from '@wallet/application/use-cases/wallet-queries';
import { WalletEventHub } from '@wallet/infrastructure/streaming/wallet-event-hub';
import { WalletModule } from '@wallet/infrastructure/wallet.module';
import { WageringController } from './wagering.controller';
import { WalletEventsController } from './wallet-events.controller';
import { WalletsController } from './wallets.controller';

@Module({
  imports: [WalletModule],
  controllers: [WalletsController, WageringController, WalletEventsController],
  providers: [
    {
      provide: WalletEventHub,
      useFactory: (
        queries: WalletQueries,
        config: AppConfig,
        metrics: Metrics,
        logger: Logger,
      ) =>
        new WalletEventHub(
          queries,
          {
            maxStreams: config.streams.maxStreams,
            pageSize: 100,
            retryMs: 3000,
            sweepIntervalMs: config.streams.sweepIntervalMs,
            heartbeatIntervalMs: config.streams.heartbeatIntervalMs,
          },
          metrics,
          logger,
        ),
      inject: [WalletQueries, APP_CONFIG, METRICS, LOGGER],
    },
  ],
})
export class WalletHttpModule {}
