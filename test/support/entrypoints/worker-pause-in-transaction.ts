import { MikroORM } from '@mikro-orm/postgresql';
import type { AppConfig } from '@platform/config/app-config';
import { MikroOrmUnitOfWork } from '@platform/database/mikro-orm-unit-of-work';
import { APP_CONFIG, METRICS } from '@platform/tokens';
import type { Metrics } from '@shared/application/metrics';
import type { UnitOfWork } from '@shared/application/unit-of-work';
import type { WageringScope } from '@wallet/application/ports/wagering-scope';
import { createWageringScope } from '@wallet/infrastructure/persistence/wagering-scope';
import { WAGERING_UNIT_OF_WORK } from '@wallet/infrastructure/wallet.module';
import { pause, startWorkerWith } from './start-worker-with';

await startWorkerWith((builder) =>
  builder.overrideProvider(WAGERING_UNIT_OF_WORK).useFactory({
    factory: (
      orm: MikroORM,
      config: AppConfig,
      metrics: Metrics,
    ): UnitOfWork<WageringScope> => {
      const real = new MikroOrmUnitOfWork(orm, createWageringScope, {
        lockTimeoutMs: config.database.lockTimeoutMs,
        metrics,
      });
      return {
        run: (work) =>
          real.run(async (scope) => {
            const result = await work(scope);
            await pause('paused inside the transaction');
            return result;
          }),
      };
    },
    inject: [MikroORM, APP_CONFIG, METRICS],
  }),
);
