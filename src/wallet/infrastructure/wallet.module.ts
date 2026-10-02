import { Module } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import type { AppConfig } from '@platform/config/app-config';
import { MikroOrmUnitOfWork } from '@platform/database/mikro-orm-unit-of-work';
import {
  APP_CONFIG,
  CLOCK,
  ID_GENERATOR,
  LOGGER,
  METRICS,
  PAYLOAD_FINGERPRINTER,
} from '@platform/tokens';
import type { Clock } from '@shared/application/clock';
import type { IdGenerator } from '@shared/application/id-generator';
import type { Logger } from '@shared/application/logger';
import type { Metrics } from '@shared/application/metrics';
import type { PayloadFingerprinter } from '@shared/application/payload-fingerprinter';
import type { UnitOfWork } from '@shared/application/unit-of-work';
import { ExponentialBackoff } from '@shared/domain/exponential-backoff';
import type { WageringScope } from '@wallet/application/ports/wagering-scope';
import { FailPendingTransaction } from '@wallet/application/use-cases/fail-pending-transaction';
import { OpenWallet } from '@wallet/application/use-cases/open-wallet';
import { ProcessPendingReference } from '@wallet/application/use-cases/process-pending-reference';
import { ReconcileWallet } from '@wallet/application/use-cases/reconcile-wallet';
import { SubmitWagerTransaction } from '@wallet/application/use-cases/submit-wager-transaction';
import { WalletQueries } from '@wallet/application/use-cases/wallet-queries';
import { SettlementPolicy } from '@wallet/domain/settlement/settlement-policy';
import { createWageringScope } from './persistence/wagering-scope';

export const WAGERING_UNIT_OF_WORK = Symbol('WAGERING_UNIT_OF_WORK');

type Scoped = UnitOfWork<WageringScope>;

const useCases = [
  OpenWallet,
  SubmitWagerTransaction,
  ProcessPendingReference,
  FailPendingTransaction,
  WalletQueries,
  ReconcileWallet,
];

@Module({
  providers: [
    {
      provide: WAGERING_UNIT_OF_WORK,
      useFactory: (orm: MikroORM, config: AppConfig, metrics: Metrics) =>
        new MikroOrmUnitOfWork(orm, createWageringScope, {
          lockTimeoutMs: config.database.lockTimeoutMs,
          metrics,
        }),
      inject: [MikroORM, APP_CONFIG, METRICS],
    },
    {
      provide: SettlementPolicy,
      useFactory: (config: AppConfig) =>
        new SettlementPolicy({
          maxReferenceAttempts: config.reference.maxAttempts,
          referenceBackoff: ExponentialBackoff.create({
            baseMs: config.reference.backoffBaseMs,
            maxMs: config.reference.backoffMaxMs,
          }),
        }),
      inject: [APP_CONFIG],
    },
    {
      provide: OpenWallet,
      useFactory: (
        unitOfWork: Scoped,
        fingerprinter: PayloadFingerprinter,
        clock: Clock,
        ids: IdGenerator,
      ) => new OpenWallet({ unitOfWork, fingerprinter, clock, ids }),
      inject: [
        WAGERING_UNIT_OF_WORK,
        PAYLOAD_FINGERPRINTER,
        CLOCK,
        ID_GENERATOR,
      ],
    },
    {
      provide: SubmitWagerTransaction,
      useFactory: (
        unitOfWork: Scoped,
        fingerprinter: PayloadFingerprinter,
        clock: Clock,
        ids: IdGenerator,
        settlement: SettlementPolicy,
        metrics: Metrics,
        logger: Logger,
      ) =>
        new SubmitWagerTransaction({
          unitOfWork,
          fingerprinter,
          clock,
          ids,
          settlement,
          metrics,
          logger,
        }),
      inject: [
        WAGERING_UNIT_OF_WORK,
        PAYLOAD_FINGERPRINTER,
        CLOCK,
        ID_GENERATOR,
        SettlementPolicy,
        METRICS,
        LOGGER,
      ],
    },
    {
      provide: ProcessPendingReference,
      useFactory: (
        unitOfWork: Scoped,
        clock: Clock,
        ids: IdGenerator,
        settlement: SettlementPolicy,
        metrics: Metrics,
        logger: Logger,
      ) =>
        new ProcessPendingReference({
          unitOfWork,
          clock,
          ids,
          settlement,
          metrics,
          logger,
        }),
      inject: [
        WAGERING_UNIT_OF_WORK,
        CLOCK,
        ID_GENERATOR,
        SettlementPolicy,
        METRICS,
        LOGGER,
      ],
    },
    {
      provide: FailPendingTransaction,
      useFactory: (
        unitOfWork: Scoped,
        clock: Clock,
        metrics: Metrics,
        logger: Logger,
      ) => new FailPendingTransaction({ unitOfWork, clock, metrics, logger }),
      inject: [WAGERING_UNIT_OF_WORK, CLOCK, METRICS, LOGGER],
    },
    {
      provide: WalletQueries,
      useFactory: (unitOfWork: Scoped) => new WalletQueries({ unitOfWork }),
      inject: [WAGERING_UNIT_OF_WORK],
    },
    {
      provide: ReconcileWallet,
      useFactory: (unitOfWork: Scoped, metrics: Metrics, logger: Logger) =>
        new ReconcileWallet({ unitOfWork, metrics, logger }),
      inject: [WAGERING_UNIT_OF_WORK, METRICS, LOGGER],
    },
  ],
  exports: [WAGERING_UNIT_OF_WORK, ...useCases],
})
export class WalletModule {}
