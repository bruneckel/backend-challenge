import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { IsolationLevel, LockMode, defineEntity, p } from '@mikro-orm/core';
import { Migration, Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { DATABASE_URL } from './support';

class Migration20261001000000SpikeAccount extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      'create table spike_account (' +
        'id int primary key, ' +
        'balance numeric not null check (scale(balance) = 2 and balance >= 0), ' +
        'version int not null)',
    );
  }

  override async down(): Promise<void> {
    this.addSql('drop table spike_account');
  }
}

const SpikeAccount = defineEntity({
  name: 'SpikeAccount',
  tableName: 'spike_account',
  properties: {
    id: p.integer().primary(),
    balance: p.decimal().columnType('numeric'),
    version: p.integer(),
  },
});

let orm: MikroORM;

async function tableExists(): Promise<boolean> {
  const rows = await orm.em
    .fork()
    .execute<{ exists: boolean }[]>(
      "select to_regclass('public.spike_account') is not null as exists",
    );
  return rows[0]?.exists === true;
}

async function resetAccount(balance: string): Promise<void> {
  const em = orm.em.fork();
  await em.nativeDelete(SpikeAccount, {});
  await em.insert(SpikeAccount, { id: 1, balance, version: 1 });
}

beforeAll(async () => {
  orm = await MikroORM.init({
    clientUrl: DATABASE_URL,
    entities: [SpikeAccount],
    extensions: [Migrator],
    migrations: {
      migrationsList: [Migration20261001000000SpikeAccount],
      tableName: 'spike_mikro_orm_migrations',
    },
  });
  await orm.migrator.up();
});

afterAll(async () => {
  await orm.migrator.down({ to: 0 });
  await orm.close(true);
});

describe('MikroORM 7 on Bun with PostgreSQL 18', () => {
  test('runs a hand-written migration down and up programmatically', async () => {
    expect(await tableExists()).toBe(true);

    await orm.migrator.down({ to: 0 });
    expect(await tableExists()).toBe(false);

    await orm.migrator.up();
    expect(await tableExists()).toBe(true);
  });

  test('reads numeric values back as exact strings', async () => {
    await resetAccount('99999999999999999.99');

    const account = await orm.em.fork().findOneOrFail(SpikeAccount, 1);

    expect(account.balance).toBe('99999999999999999.99');
  });

  test('rejects a value with three decimals instead of rounding it', async () => {
    await resetAccount('10.00');

    const write = orm.em.fork().nativeUpdate(SpikeAccount, { id: 1 }, { balance: '10.005' });

    expect(write).rejects.toMatchObject({ code: '23514' });
  });

  test('makes a second locker wait for the first commit and then see its update', async () => {
    await resetAccount('100.00');
    const order: string[] = [];

    const first = orm.em.fork().transactional(
      async (em) => {
        const account = await em.findOneOrFail(SpikeAccount, 1, {
          lockMode: LockMode.PESSIMISTIC_WRITE,
        });
        order.push('first locked');
        await Bun.sleep(300);
        await em.nativeUpdate(
          SpikeAccount,
          { id: 1, version: account.version },
          { balance: '20.00', version: account.version + 1 },
        );
        order.push('first done');
      },
      { isolationLevel: IsolationLevel.READ_COMMITTED },
    );

    await Bun.sleep(50);
    const second = orm.em.fork().transactional(
      async (em) => {
        order.push('second waiting');
        const account = await em.findOneOrFail(SpikeAccount, 1, {
          lockMode: LockMode.PESSIMISTIC_WRITE,
        });
        order.push('second locked');
        return account.balance;
      },
      { isolationLevel: IsolationLevel.READ_COMMITTED },
    );

    const [, balanceSeenBySecond] = await Promise.all([first, second]);

    expect(order).toEqual(['first locked', 'second waiting', 'first done', 'second locked']);
    expect(balanceSeenBySecond).toBe('20.00');
  });

  test('refuses a pessimistic lock outside a transaction', async () => {
    await resetAccount('100.00');

    const lockWithoutTransaction = orm.em
      .fork()
      .findOne(SpikeAccount, 1, { lockMode: LockMode.PESSIMISTIC_WRITE });

    expect(lockWithoutTransaction).rejects.toThrow();
  });

  test('gives up waiting for a lock with SQLSTATE 55P03 when lock_timeout expires', async () => {
    await resetAccount('100.00');
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const holder = orm.em.fork().transactional(async (em) => {
      await em.findOneOrFail(SpikeAccount, 1, { lockMode: LockMode.PESSIMISTIC_WRITE });
      await held;
    });
    await Bun.sleep(50);

    const waiter = orm.em.fork().transactional(async (em) => {
      await em.execute("set local lock_timeout = '100ms'");
      await em.findOneOrFail(SpikeAccount, 1, { lockMode: LockMode.PESSIMISTIC_WRITE });
    });

    await expect(waiter).rejects.toMatchObject({ code: '55P03' });
    release();
    await holder;
  });

  test('surfaces unique violations with SQLSTATE 23505', async () => {
    await resetAccount('100.00');

    const duplicate = orm.em.fork().insert(SpikeAccount, { id: 1, balance: '1.00', version: 1 });

    expect(duplicate).rejects.toMatchObject({ code: '23505' });
  });

  test('turns a nested transactional call into a savepoint by default', async () => {
    await resetAccount('100.00');

    await orm.em.fork().transactional(async (em) => {
      await em.nativeUpdate(SpikeAccount, { id: 1 }, { balance: '30.00' });
      await em
        .transactional(async (inner) => {
          await inner.nativeUpdate(SpikeAccount, { id: 1 }, { balance: '40.00' });
          throw new Error('inner failure');
        })
        .catch(() => undefined);
    });

    const account = await orm.em.fork().findOneOrFail(SpikeAccount, 1);
    expect(account.balance).toBe('30.00');
  });
});
