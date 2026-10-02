import { Migration } from '@mikro-orm/migrations';

const MONEY_LIMIT = '100000000000000000';

const FAILURE_CODES = [
  'INSUFFICIENT_FUNDS',
  'REVERSAL_INSUFFICIENT_FUNDS',
  'CURRENCY_MISMATCH',
  'WALLET_PLAYER_MISMATCH',
  'REFERENCE_NOT_FOUND',
  'REFERENCE_MISMATCH',
  'INVALID_REFERENCE_KIND',
  'REFERENCE_AMOUNT_MISMATCH',
  'REFERENCE_NOT_PROCESSED',
  'REFERENCE_ALREADY_REVERSED',
  'PROCESSING_FAILED',
];

const money = (column: string, sign: '>=' | '>') =>
  `scale(${column}) = 2 and ${column} ${sign} 0 and ${column} < ${MONEY_LIMIT}`;

const list = (values: readonly string[]) =>
  values.map((value) => `'${value}'`).join(', ');

export class Migration20261002120000CreateWageringSchema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid not null,
        player_id uuid not null,
        currency text not null,
        balance_amount numeric not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_pkey primary key (id),
        constraint wallets_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_balance_amount_money check (${money('balance_amount', '>=')}),
        constraint wallets_version_positive check (version >= 1),
        constraint wallets_player_currency_key unique (player_id, currency),
        constraint wallets_id_currency_key unique (id, currency)
      )
    `);

    this.addSql(`
      create table wager_transactions (
        id uuid not null,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        wallet_id uuid not null,
        player_id uuid not null,
        round_id text not null,
        game_id text not null,
        kind text not null,
        amount numeric not null,
        currency text not null,
        reference_external_transaction_id text,
        correlation_id text not null,
        status text not null,
        failure_code text,
        reference_transaction_id uuid,
        processed_at timestamptz,
        result_balance_amount numeric,
        result_balance_currency text,
        reference_attempts integer not null default 0,
        next_reference_attempt_at timestamptz,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wager_transactions_pkey primary key (id),
        constraint wager_transactions_provider_id_length check (length(provider_id) between 1 and 64),
        constraint wager_transactions_external_transaction_id_length
          check (length(external_transaction_id) between 1 and 128),
        constraint wager_transactions_idempotency_key_length check (length(idempotency_key) between 1 and 255),
        constraint wager_transactions_payload_hash_format check (payload_hash ~ '^[0-9a-f]{64}$'),
        constraint wager_transactions_round_id_length check (length(round_id) between 1 and 128),
        constraint wager_transactions_game_id_length check (length(game_id) between 1 and 128),
        constraint wager_transactions_kind_known
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint wager_transactions_amount_money check (${money('amount', '>=')}),
        constraint wager_transactions_amount_positive check (amount > 0 or kind = 'LOSS'),
        constraint wager_transactions_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wager_transactions_reference_external_transaction_id_length
          check (length(reference_external_transaction_id) between 1 and 128),
        constraint wager_transactions_correlation_id_length check (length(correlation_id) between 1 and 255),
        constraint wager_transactions_status_persisted
          check (status in ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_transactions_failure_code_known check (failure_code in (${list(FAILURE_CODES)})),
        constraint wager_transactions_result_balance_amount_money check (${money('result_balance_amount', '>=')}),
        constraint wager_transactions_result_balance_currency_format check (result_balance_currency ~ '^[A-Z]{3}$'),
        constraint wager_transactions_reference_attempts_non_negative check (reference_attempts >= 0),
        constraint wager_transactions_reference_required
          check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_transactions_reference_forbidden
          check (kind not in ('BET', 'OPENING') or reference_external_transaction_id is null),
        constraint wager_transactions_internal_provider_opening check ((provider_id = 'internal') = (kind = 'OPENING')),
        constraint wager_transactions_failure_code_status
          check ((failure_code is not null) = (status in ('REJECTED', 'FAILED'))),
        constraint wager_transactions_processed_at_status check ((processed_at is not null) = (status = 'PROCESSED')),
        constraint wager_transactions_schedule_status
          check ((next_reference_attempt_at is not null) = (status = 'PENDING_REFERENCE')),
        constraint wager_transactions_reference_resolution check (
          (reference_transaction_id is not null) = (status = 'PROCESSED' and reference_external_transaction_id is not null)
        ),
        constraint wager_transactions_not_self_reference check (reference_transaction_id <> id),
        constraint wager_transactions_result_balance_pair
          check ((result_balance_amount is null) = (result_balance_currency is null)),
        constraint wager_transactions_result_balance_known
          check (status not in ('PROCESSED', 'REJECTED', 'PENDING_REFERENCE') or result_balance_amount is not null),
        constraint wager_transactions_idempotency_key_key unique (idempotency_key),
        constraint wager_transactions_provider_external_key unique (provider_id, external_transaction_id),
        constraint wager_transactions_id_wallet_currency_key unique (id, wallet_id, currency),
        constraint wager_transactions_wallet_fkey foreign key (wallet_id) references wallets (id),
        constraint wager_transactions_result_balance_currency_fkey
          foreign key (wallet_id, result_balance_currency) references wallets (id, currency),
        constraint wager_transactions_reference_transaction_fkey
          foreign key (reference_transaction_id) references wager_transactions (id)
      )
    `);
    this.addSql(`
      create unique index wager_transactions_one_reversal_per_kind
        on wager_transactions (reference_transaction_id, kind)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK')
    `);
    this.addSql(`
      create unique index wager_transactions_one_opening_per_wallet
        on wager_transactions (wallet_id)
        where kind = 'OPENING'
    `);
    this.addSql(`
      create index wager_transactions_due_references
        on wager_transactions (next_reference_attempt_at)
        where status = 'PENDING_REFERENCE'
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid not null,
        wallet_id uuid not null,
        transaction_id uuid not null,
        wallet_version integer not null,
        direction text not null,
        amount numeric not null,
        currency text not null,
        balance_before numeric not null,
        balance_after numeric not null,
        created_at timestamptz not null,
        constraint wallet_ledger_entries_pkey primary key (id),
        constraint wallet_ledger_entries_wallet_version_positive check (wallet_version >= 1),
        constraint wallet_ledger_entries_direction_known check (direction in ('DEBIT', 'CREDIT')),
        constraint wallet_ledger_entries_amount_money check (${money('amount', '>')}),
        constraint wallet_ledger_entries_balance_before_money check (${money('balance_before', '>=')}),
        constraint wallet_ledger_entries_balance_after_money check (${money('balance_after', '>=')}),
        constraint wallet_ledger_entries_arithmetic check (
          case direction
            when 'CREDIT' then balance_after = balance_before + amount
            when 'DEBIT' then balance_after = balance_before - amount
          end
        ),
        constraint wallet_ledger_entries_wallet_transaction_key unique (wallet_id, transaction_id),
        constraint wallet_ledger_entries_wallet_version_key unique (wallet_id, wallet_version),
        constraint wallet_ledger_entries_wallet_currency_fkey
          foreign key (wallet_id, currency) references wallets (id, currency),
        constraint wallet_ledger_entries_transaction_fkey
          foreign key (transaction_id, wallet_id, currency) references wager_transactions (id, wallet_id, currency)
      )
    `);

    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null,
        transaction_id uuid,
        received_at timestamptz not null,
        processed_at timestamptz,
        constraint inbox_messages_pkey primary key (consumer_name, message_id),
        constraint inbox_messages_consumer_name_length check (length(consumer_name) between 1 and 128),
        constraint inbox_messages_message_id_length check (length(message_id) between 1 and 255),
        constraint inbox_messages_payload_hash_format check (payload_hash ~ '^[0-9a-f]{64}$'),
        constraint inbox_messages_transaction_fkey foreign key (transaction_id) references wager_transactions (id)
      )
    `);

    this.addSql(`
      create table outbox_messages (
        id uuid not null,
        aggregate_id uuid not null,
        event_type text not null,
        event_version integer not null,
        message_group_id text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz not null,
        published_at timestamptz,
        last_error text,
        constraint outbox_messages_pkey primary key (id),
        constraint outbox_messages_event_type_length check (length(event_type) between 1 and 128),
        constraint outbox_messages_event_version_positive check (event_version >= 1),
        constraint outbox_messages_message_group_id_length check (length(message_group_id) between 1 and 128),
        constraint outbox_messages_attempts_non_negative check (attempts >= 0),
        constraint outbox_messages_last_error_length check (length(last_error) <= 500)
      )
    `);
    this.addSql(`
      create index outbox_messages_pending
        on outbox_messages (next_attempt_at)
        where published_at is null
    `);

    this.addSql(`
      create function reject_mutation() returns trigger language plpgsql as $$
      begin
        raise exception '% on % is not allowed', tg_op, tg_table_name using errcode = 'restrict_violation';
      end;
      $$
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_append_only
        before update or delete on wallet_ledger_entries
        for each row execute function reject_mutation()
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function reject_mutation()
    `);
    this.addSql(`
      create trigger wager_transactions_no_delete
        before delete on wager_transactions
        for each row execute function reject_mutation()
    `);

    this.addSql(`
      create function guard_wager_transaction_update() returns trigger language plpgsql as $$
      begin
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager transaction % is % and cannot change', old.id, old.status
            using errcode = 'restrict_violation';
        end if;
        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
            new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount, new.currency,
            new.reference_external_transaction_id, new.correlation_id, new.created_at)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
            old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount, old.currency,
            old.reference_external_transaction_id, old.correlation_id, old.created_at) then
          raise exception 'immutable columns of wager transaction % cannot change', old.id
            using errcode = 'restrict_violation';
        end if;
        return new;
      end;
      $$
    `);
    this.addSql(`
      create trigger wager_transactions_guard_update
        before update on wager_transactions
        for each row execute function guard_wager_transaction_update()
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table outbox_messages');
    this.addSql('drop table inbox_messages');
    this.addSql('drop table wallet_ledger_entries');
    this.addSql('drop table wager_transactions');
    this.addSql('drop table wallets');
    this.addSql('drop function guard_wager_transaction_update()');
    this.addSql('drop function reject_mutation()');
  }
}
