import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { AppConfig } from '@platform/config/app-config';
import { PollingLoop } from '@platform/lifecycle/polling-loop';
import { APP_CONFIG, CLOCK } from '@platform/tokens';
import type { Clock } from '@shared/application/clock';
import type { UnitOfWork } from '@shared/application/unit-of-work';
import { ExponentialBackoff } from '@shared/domain/exponential-backoff';
import type { WageringScope } from '@wallet/application/ports/wagering-scope';
import { FailPendingTransaction } from '@wallet/application/use-cases/fail-pending-transaction';
import { ProcessPendingReference } from '@wallet/application/use-cases/process-pending-reference';
import { ResolvePendingReferences } from '@wallet/application/use-cases/resolve-pending-references';
import {
  WAGERING_UNIT_OF_WORK,
  WalletModule,
} from '@wallet/infrastructure/wallet.module';

@Injectable()
export class PendingReferenceSchedulerRunner
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly loop: PollingLoop;

  constructor(
    resolve: ResolvePendingReferences,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.loop = new PollingLoop({
      step: async () =>
        (await resolve.runOnce()).candidates ===
        config.reference.schedulerBatchSize,
      idleDelayMs: config.reference.schedulerPollIntervalMs,
      errorBackoff: ExponentialBackoff.create({ baseMs: 1000, maxMs: 30_000 }),
      onError: (error, consecutiveFailures) =>
        process.stderr.write(
          `${JSON.stringify({
            level: 'error',
            msg: 'pending reference scheduler step failed',
            errorName: error instanceof Error ? error.name : typeof error,
            consecutiveFailures,
          })}\n`,
        ),
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
  imports: [WalletModule],
  providers: [
    {
      provide: FailPendingTransaction,
      useFactory: (unitOfWork: UnitOfWork<WageringScope>, clock: Clock) =>
        new FailPendingTransaction({ unitOfWork, clock }),
      inject: [WAGERING_UNIT_OF_WORK, CLOCK],
    },
    {
      provide: ResolvePendingReferences,
      useFactory: (
        unitOfWork: UnitOfWork<WageringScope>,
        clock: Clock,
        process: ProcessPendingReference,
        fail: FailPendingTransaction,
        config: AppConfig,
      ) =>
        new ResolvePendingReferences({
          unitOfWork,
          clock,
          process,
          fail,
          batchSize: config.reference.schedulerBatchSize,
          maxProcessingFailures: config.reference.maxProcessingFailures,
        }),
      inject: [
        WAGERING_UNIT_OF_WORK,
        CLOCK,
        ProcessPendingReference,
        FailPendingTransaction,
        APP_CONFIG,
      ],
    },
    PendingReferenceSchedulerRunner,
  ],
})
export class PendingReferenceSchedulerModule {}
