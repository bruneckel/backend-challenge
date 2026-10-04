import { Migration } from '@mikro-orm/migrations';

export class Migration20261004130000ScopeIdempotencyKeyByProvider extends Migration {
  override isTransactional(): boolean {
    return false;
  }

  override async up(): Promise<void> {
    this.addSql(
      'create unique index concurrently if not exists wager_transactions_provider_idempotency_key_key on wager_transactions (provider_id, idempotency_key)',
    );
    this.addSql(
      'alter table wager_transactions add constraint wager_transactions_provider_idempotency_key_key unique using index wager_transactions_provider_idempotency_key_key',
    );
    this.addSql(
      'alter table wager_transactions drop constraint wager_transactions_idempotency_key_key',
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      'create unique index concurrently if not exists wager_transactions_idempotency_key_key on wager_transactions (idempotency_key)',
    );
    this.addSql(
      'alter table wager_transactions add constraint wager_transactions_idempotency_key_key unique using index wager_transactions_idempotency_key_key',
    );
    this.addSql(
      'alter table wager_transactions drop constraint wager_transactions_provider_idempotency_key_key',
    );
  }
}
