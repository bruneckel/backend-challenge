import { Migration } from '@mikro-orm/migrations';

export class Migration20261003160000IndexInboxReceivedAt extends Migration {
  override isTransactional(): boolean {
    return false;
  }

  override async up(): Promise<void> {
    this.addSql(
      'create index concurrently if not exists inbox_messages_received_at on inbox_messages (received_at)',
    );
  }

  override async down(): Promise<void> {
    this.addSql('drop index concurrently if exists inbox_messages_received_at');
  }
}
