import { Migration } from '@mikro-orm/migrations';

export class Migration20261004120000CreateMaintenanceLeases extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table maintenance_leases (
        name text not null,
        holder text not null,
        expires_at timestamptz not null,
        constraint maintenance_leases_pkey primary key (name),
        constraint maintenance_leases_name_length check (length(name) between 1 and 64),
        constraint maintenance_leases_holder_length check (length(holder) between 1 and 255)
      )
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table maintenance_leases');
  }
}
