import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { MikroOrmUnitOfWork } from '@platform/database/mikro-orm-unit-of-work';
import { createOrm } from '@platform/database/orm';
import { TransientFailure } from '@shared/application/transient-failure';
import { NestedUnitOfWorkError } from '@shared/application/unit-of-work';
import { rejectionOf } from '@test/support/async';
import {
  type Row,
  type TestDatabase,
  createMigratedDatabase,
  insertRow,
} from '@test/support/database';
import { RecordingMetrics } from '@test/support/recording-metrics';
import { walletRow } from '@test/support/schema-rows';

interface RawScope {
  em: EntityManager;
}

let database: TestDatabase;
let orm: MikroORM;
let unitOfWork: MikroOrmUnitOfWork<RawScope>;
const metrics = new RecordingMetrics();

beforeAll(async () => {
  database = await createMigratedDatabase();
  orm = await createOrm({
    databaseUrl: database.url,
    entities: [],
    statementTimeoutMs: 5000,
    idleInTransactionTimeoutMs: 7000,
  });
  unitOfWork = new MikroOrmUnitOfWork(orm, (em) => ({ em }), {
    lockTimeoutMs: 200,
    metrics,
  });
});

afterAll(async () => {
  await orm.close(true);
  await database.drop();
});

function insertWallet(em: EntityManager, row: Row): Promise<unknown> {
  return em.execute(
    'insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)',
    [
      row.id,
      row.player_id,
      row.currency,
      row.balance_amount,
      row.version,
      row.created_at,
      row.updated_at,
    ],
  );
}

async function walletExists(id: unknown): Promise<boolean> {
  const rows = await database.sql`select 1 from wallets where id = ${id}`;
  return rows.length === 1;
}

async function setting(em: EntityManager, name: string): Promise<unknown> {
  const [row] = await em.execute<Record<string, unknown>[]>(`show ${name}`);
  return row?.[name];
}

describe('MikroOrmUnitOfWork', () => {
  test('commits the work and returns its result', async () => {
    const wallet = walletRow({ balance_amount: '0.00' });

    const result = await unitOfWork.run(async ({ em }) => {
      await insertWallet(em, wallet);
      return 'done';
    });

    expect(result).toBe('done');
    expect(await walletExists(wallet.id)).toBe(true);
  });

  test('rolls back every write and rethrows when the work fails', async () => {
    const wallet = walletRow({ balance_amount: '0.00' });
    const failure = new Error('boom');

    const run = unitOfWork.run(async ({ em }) => {
      await insertWallet(em, wallet);
      throw failure;
    });

    expect(await rejectionOf(run)).toBe(failure);
    expect(await walletExists(wallet.id)).toBe(false);
  });

  test('keeps concurrent units of work in separate transactions', async () => {
    const committed = walletRow({ balance_amount: '0.00' });
    const rolledBack = walletRow({ balance_amount: '0.00' });

    const results = await Promise.allSettled([
      unitOfWork.run(async ({ em }) => {
        await insertWallet(em, committed);
        await Bun.sleep(50);
      }),
      unitOfWork.run(async ({ em }) => {
        await insertWallet(em, rolledBack);
        await Bun.sleep(25);
        throw new Error('boom');
      }),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(await walletExists(committed.id)).toBe(true);
    expect(await walletExists(rolledBack.id)).toBe(false);
  });

  test('runs in READ COMMITTED', async () => {
    expect(
      await unitOfWork.run(({ em }) => setting(em, 'transaction_isolation')),
    ).toBe('read committed');
  });

  test('sets the lock timeout for its own transaction only', async () => {
    expect(await unitOfWork.run(({ em }) => setting(em, 'lock_timeout'))).toBe(
      '200ms',
    );
    expect(await setting(orm.em.fork(), 'lock_timeout')).toBe('0');
  });

  test('refuses to start inside another unit of work and rolls the outer one back', async () => {
    const wallet = walletRow({ balance_amount: '0.00' });
    let innerRan = false;

    const outer = unitOfWork.run(async ({ em }) => {
      await insertWallet(em, wallet);
      await unitOfWork.run(async () => {
        innerRan = true;
      });
    });

    expect(await rejectionOf(outer)).toBeInstanceOf(NestedUnitOfWorkError);
    expect(innerRan).toBe(false);
    expect(await walletExists(wallet.id)).toBe(false);
  });

  test('refuses nesting across different units of work', async () => {
    const other = new MikroOrmUnitOfWork(orm, (em) => ({ em }), {
      lockTimeoutMs: 200,
    });

    const outer = unitOfWork.run(() => other.run(async () => 'inner'));

    expect(await rejectionOf(outer)).toBeInstanceOf(NestedUnitOfWorkError);
  });

  test('reports a lock wait that exceeds the timeout as a transient failure', async () => {
    const wallet = walletRow({ balance_amount: '0.00' });
    await insertRow(database.sql, 'wallets', wallet);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });

    const holder = unitOfWork.run(async ({ em }) => {
      await em.execute('select id from wallets where id = ? for update', [
        wallet.id,
      ]);
      signalLocked();
      await held;
    });
    await locked;
    const failure = await rejectionOf(
      unitOfWork.run(({ em }) =>
        em.execute('select id from wallets where id = ? for update', [
          wallet.id,
        ]),
      ),
    );
    release();
    await holder;

    expect(failure).toBeInstanceOf(TransientFailure);
    expect((failure as TransientFailure).reason).toBe('lock_timeout');
    expect(metrics.count('wallet_lock_timeouts_total')).toBe(1);
  });
});

describe('createOrm', () => {
  test('sets the statement and idle-in-transaction timeouts on every connection', async () => {
    const em = orm.em.fork();

    expect(await setting(em, 'statement_timeout')).toBe('5s');
    expect(await setting(em, 'idle_in_transaction_session_timeout')).toBe('7s');
  });
});
