import { Migration } from '@mikro-orm/migrations';

export class Migration20261003170000GuardWalletBalanceWithLedger extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create function check_wallet_matches_ledger() returns trigger language plpgsql as $$
      declare
        entry_balance numeric;
      begin
        select balance_after into entry_balance
        from wallet_ledger_entries
        where wallet_id = new.id and wallet_version = new.version;
        if not found then
          if new.version = 1 and new.balance_amount = 0 then
            return null;
          end if;
          raise exception 'wallet % at version % has no ledger entry for that version', new.id, new.version
            using errcode = 'check_violation', constraint = 'wallets_balance_matches_ledger';
        end if;
        if entry_balance <> new.balance_amount then
          raise exception 'wallet % at version % does not match its ledger entry', new.id, new.version
            using errcode = 'check_violation', constraint = 'wallets_balance_matches_ledger';
        end if;
        return null;
      end;
      $$
    `);
    this.addSql(`
      create constraint trigger wallets_balance_matches_ledger
        after insert or update of balance_amount, version on wallets
        deferrable initially deferred
        for each row execute function check_wallet_matches_ledger()
    `);
    this.addSql(`
      create function check_ledger_entry_chain() returns trigger language plpgsql as $$
      declare
        previous_balance numeric;
        current_version integer;
      begin
        if new.wallet_version > 1 then
          select balance_after into previous_balance
          from wallet_ledger_entries
          where wallet_id = new.wallet_id and wallet_version = new.wallet_version - 1;
        end if;
        if previous_balance is null and new.wallet_version > 2 then
          raise exception 'ledger entry % of wallet % skips version %', new.id, new.wallet_id, new.wallet_version - 1
            using errcode = 'check_violation', constraint = 'wallet_ledger_entries_follow_chain';
        end if;
        if new.balance_before <> coalesce(previous_balance, 0) then
          raise exception 'ledger entry % of wallet % does not start from the previous balance', new.id, new.wallet_id
            using errcode = 'check_violation', constraint = 'wallet_ledger_entries_follow_chain';
        end if;
        select version into current_version from wallets where id = new.wallet_id;
        if current_version < new.wallet_version then
          raise exception 'ledger entry % is ahead of wallet % at version %', new.id, new.wallet_id, current_version
            using errcode = 'check_violation', constraint = 'wallet_ledger_entries_follow_chain';
        end if;
        return null;
      end;
      $$
    `);
    this.addSql(`
      create constraint trigger wallet_ledger_entries_follow_chain
        after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function check_ledger_entry_chain()
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      'drop trigger wallet_ledger_entries_follow_chain on wallet_ledger_entries',
    );
    this.addSql('drop function check_ledger_entry_chain()');
    this.addSql('drop trigger wallets_balance_matches_ledger on wallets');
    this.addSql('drop function check_wallet_matches_ledger()');
  }
}
