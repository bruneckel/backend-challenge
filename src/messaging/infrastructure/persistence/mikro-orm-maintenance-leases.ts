import type { EntityManager } from '@mikro-orm/postgresql';
import type { MaintenanceLeases } from '@messaging/application/ports/maintenance-leases';

export class MikroOrmMaintenanceLeases implements MaintenanceLeases {
  constructor(private readonly em: EntityManager) {}

  async acquire(
    name: string,
    holder: string,
    durationMs: number,
  ): Promise<boolean> {
    const rows = await this.em.execute<{ holder: string }[]>(
      `insert into maintenance_leases (name, holder, expires_at)
        values (?, ?, now() + make_interval(secs => ?::float8))
        on conflict (name) do update
          set holder = excluded.holder, expires_at = excluded.expires_at
          where maintenance_leases.holder = excluded.holder
             or maintenance_leases.expires_at <= now()
        returning holder`,
      [name, holder, durationMs / 1000],
      'all',
    );
    return rows.length === 1;
  }

  async release(name: string, holder: string): Promise<void> {
    await this.em.execute(
      'update maintenance_leases set expires_at = now() where name = ? and holder = ?',
      [name, holder],
      'run',
    );
  }
}
