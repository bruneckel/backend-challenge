import { Migration20261002120000CreateWageringSchema } from './migration-20261002120000-create-wagering-schema';
import { Migration20261003140000AllowBalanceLimitFailureCode } from './migration-20261003140000-allow-balance-limit-failure-code';
import { Migration20261003160000IndexInboxReceivedAt } from './migration-20261003160000-index-inbox-received-at';
import { Migration20261003170000GuardWalletBalanceWithLedger } from './migration-20261003170000-guard-wallet-balance-with-ledger';

export const migrations = [
  Migration20261002120000CreateWageringSchema,
  Migration20261003140000AllowBalanceLimitFailureCode,
  Migration20261003160000IndexInboxReceivedAt,
  Migration20261003170000GuardWalletBalanceWithLedger,
];
