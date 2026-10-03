import { Migration } from '@mikro-orm/migrations';

const PREVIOUS_CODES = [
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

const CURRENT_CODES = [...PREVIOUS_CODES, 'BALANCE_LIMIT_EXCEEDED'];

const knownCodes = (codes: readonly string[]) => `
  alter table wager_transactions
    add constraint wager_transactions_failure_code_known
    check (failure_code in (${codes.map((code) => `'${code}'`).join(', ')}))`;

const DROP =
  'alter table wager_transactions drop constraint wager_transactions_failure_code_known';

export class Migration20261003140000AllowBalanceLimitFailureCode extends Migration {
  override async up(): Promise<void> {
    this.addSql(DROP);
    this.addSql(knownCodes(CURRENT_CODES));
  }

  override async down(): Promise<void> {
    this.addSql(DROP);
    this.addSql(knownCodes(PREVIOUS_CODES));
  }
}
