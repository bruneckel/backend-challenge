import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type PersistenceHarness,
  createPersistenceHarness,
} from '@test/support/persistence';

let harness: PersistenceHarness;

beforeAll(async () => {
  harness = await createPersistenceHarness();
});

afterAll(async () => {
  await harness.close();
});

const acquire = (name: string, holder: string, durationMs = 60_000) =>
  harness.retentionUnitOfWork.run(({ leases }) =>
    leases.acquire(name, holder, durationMs),
  );

const release = (name: string, holder: string) =>
  harness.retentionUnitOfWork.run(({ leases }) => leases.release(name, holder));

describe('MikroOrmMaintenanceLeases', () => {
  test('grants a lease to one holder at a time and renews it for that holder', async () => {
    expect(await acquire('job-a', 'worker-1')).toBe(true);
    expect(await acquire('job-a', 'worker-2')).toBe(false);
    expect(await acquire('job-a', 'worker-1')).toBe(true);
  });

  test('lets another holder take a lease that expired', async () => {
    expect(await acquire('job-b', 'worker-1', 50)).toBe(true);
    await Bun.sleep(80);

    expect(await acquire('job-b', 'worker-2')).toBe(true);
    expect(await acquire('job-b', 'worker-1')).toBe(false);
  });

  test('releases only the lease of its own holder', async () => {
    await acquire('job-c', 'worker-1');

    await release('job-c', 'worker-2');
    expect(await acquire('job-c', 'worker-2')).toBe(false);

    await release('job-c', 'worker-1');
    expect(await acquire('job-c', 'worker-2')).toBe(true);
  });
});
