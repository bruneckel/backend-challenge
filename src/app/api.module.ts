import { type DynamicModule, Module } from '@nestjs/common';
import { messagingEntities } from '@messaging/infrastructure/persistence/messaging-entities';
import { HealthModule } from '@observability/health/health.module';
import type { AppConfig } from '@platform/config/app-config';
import { ShutdownLogger } from '@platform/lifecycle/shutdown-logger';
import { PlatformModule } from '@platform/platform.module';
import { WalletHttpModule } from '@wallet/infrastructure/http/wallet-http.module';
import { walletEntities } from '@wallet/infrastructure/persistence/wallet-entities';

@Module({})
export class ApiModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ApiModule,
      imports: [
        PlatformModule.forRoot({ config, entities: [...walletEntities, ...messagingEntities] }),
        HealthModule,
        WalletHttpModule,
      ],
      providers: [ShutdownLogger],
    };
  }
}
