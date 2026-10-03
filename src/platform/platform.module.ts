import { type DynamicModule, Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { PrometheusMetrics } from '@observability/metrics/prometheus-metrics';
import { AuthGuard } from '@platform/auth/auth.guard';
import { JwtTokenVerifier } from '@platform/auth/jwt-token-verifier';
import type { AppConfig } from '@platform/config/app-config';
import { CanonicalJsonFingerprinter } from '@platform/crypto/canonical-json-fingerprinter';
import { DatabaseHealth } from '@platform/database/database-health';
import { DatabaseLifecycle } from '@platform/database/database-lifecycle';
import { type OrmSettings, createOrm } from '@platform/database/orm';
import { UuidV7Generator } from '@platform/ids/uuid-v7-generator';
import { SystemClock } from '@platform/time/system-clock';
import {
  APP_CONFIG,
  CLOCK,
  ID_GENERATOR,
  LOGGER,
  METRICS,
  PAYLOAD_FINGERPRINTER,
  TOKEN_VERIFIER,
} from '@platform/tokens';
import type { Logger } from '@shared/application/logger';

export interface PlatformOptions {
  config: AppConfig;
  entities: OrmSettings['entities'];
  logger: Logger;
  metrics: PrometheusMetrics;
}

@Global()
@Module({})
export class PlatformModule {
  static forRoot(options: PlatformOptions): DynamicModule {
    const { config, entities, logger, metrics } = options;
    return {
      module: PlatformModule,
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: LOGGER, useValue: logger },
        { provide: METRICS, useValue: metrics },
        { provide: PrometheusMetrics, useValue: metrics },
        {
          provide: MikroORM,
          useFactory: () =>
            createOrm({
              databaseUrl: config.databaseUrl,
              entities,
              poolSize: config.database.poolSize,
              statementTimeoutMs: config.database.statementTimeoutMs,
              idleInTransactionTimeoutMs:
                config.database.idleInTransactionTimeoutMs,
            }),
        },
        DatabaseLifecycle,
        DatabaseHealth,
        { provide: CLOCK, useClass: SystemClock },
        { provide: ID_GENERATOR, useClass: UuidV7Generator },
        {
          provide: PAYLOAD_FINGERPRINTER,
          useClass: CanonicalJsonFingerprinter,
        },
        {
          provide: TOKEN_VERIFIER,
          useFactory: () => new JwtTokenVerifier(config.auth),
        },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
      exports: [
        APP_CONFIG,
        LOGGER,
        METRICS,
        PrometheusMetrics,
        MikroORM,
        DatabaseHealth,
        CLOCK,
        ID_GENERATOR,
        PAYLOAD_FINGERPRINTER,
        TOKEN_VERIFIER,
      ],
    };
  }
}
