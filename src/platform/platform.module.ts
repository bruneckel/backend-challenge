import { type DynamicModule, Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { AuthGuard } from '@platform/auth/auth.guard';
import { AnonymousProviderIdentity } from '@platform/auth/provider-identity';
import type { AppConfig } from '@platform/config/app-config';
import { CanonicalJsonFingerprinter } from '@platform/crypto/canonical-json-fingerprinter';
import { DatabaseHealth } from '@platform/database/database-health';
import { DatabaseLifecycle } from '@platform/database/database-lifecycle';
import { type OrmSettings, createOrm } from '@platform/database/orm';
import { UuidV7Generator } from '@platform/ids/uuid-v7-generator';
import { SystemClock } from '@platform/time/system-clock';
import { APP_CONFIG, CLOCK, ID_GENERATOR, PAYLOAD_FINGERPRINTER, PROVIDER_IDENTITY } from '@platform/tokens';

export interface PlatformOptions {
  config: AppConfig;
  entities: OrmSettings['entities'];
}

@Global()
@Module({})
export class PlatformModule {
  static forRoot(options: PlatformOptions): DynamicModule {
    const { config, entities } = options;
    return {
      module: PlatformModule,
      providers: [
        { provide: APP_CONFIG, useValue: config },
        {
          provide: MikroORM,
          useFactory: () =>
            createOrm({
              databaseUrl: config.databaseUrl,
              entities,
              poolSize: config.database.poolSize,
              statementTimeoutMs: config.database.statementTimeoutMs,
              idleInTransactionTimeoutMs: config.database.idleInTransactionTimeoutMs,
            }),
        },
        DatabaseLifecycle,
        DatabaseHealth,
        { provide: CLOCK, useClass: SystemClock },
        { provide: ID_GENERATOR, useClass: UuidV7Generator },
        { provide: PAYLOAD_FINGERPRINTER, useClass: CanonicalJsonFingerprinter },
        { provide: PROVIDER_IDENTITY, useClass: AnonymousProviderIdentity },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
      exports: [APP_CONFIG, MikroORM, DatabaseHealth, CLOCK, ID_GENERATOR, PAYLOAD_FINGERPRINTER, PROVIDER_IDENTITY],
    };
  }
}
