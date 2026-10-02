import { AsyncLocalStorage } from 'node:async_hooks';
import { IsolationLevel } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { TransientFailure } from '@shared/application/transient-failure';
import { NestedUnitOfWorkError, type UnitOfWork } from '@shared/application/unit-of-work';
import { classifyDatabaseError } from './database-failure';

const activeUnitOfWork = new AsyncLocalStorage<true>();

export interface UnitOfWorkSettings {
  lockTimeoutMs: number;
}

export class MikroOrmUnitOfWork<TScope> implements UnitOfWork<TScope> {
  constructor(
    private readonly orm: MikroORM,
    private readonly scopeFor: (em: EntityManager) => TScope,
    private readonly settings: UnitOfWorkSettings,
  ) {}

  async run<T>(work: (scope: TScope) => Promise<T>): Promise<T> {
    if (activeUnitOfWork.getStore() !== undefined) {
      throw new NestedUnitOfWorkError();
    }
    try {
      return await activeUnitOfWork.run(true, () => this.transaction(work));
    } catch (error) {
      throw asTransientFailure(error) ?? error;
    }
  }

  private transaction<T>(work: (scope: TScope) => Promise<T>): Promise<T> {
    const em = this.orm.em.fork({ clear: true, disableContextResolution: true });
    return em.transactional(
      async (transactionEm) => {
        await transactionEm.execute('select set_config(?, ?, true)', ['lock_timeout', `${this.settings.lockTimeoutMs}ms`]);
        return work(this.scopeFor(transactionEm));
      },
      { isolationLevel: IsolationLevel.READ_COMMITTED },
    );
  }
}

function asTransientFailure(error: unknown): TransientFailure | undefined {
  const failure = classifyDatabaseError(error);
  return failure.kind === 'transient' ? new TransientFailure(failure.reason, { cause: error }) : undefined;
}
