import { Migration20261002120000CreateWageringSchema } from './migration-20261002120000-create-wagering-schema';
import { Migration20261003140000AllowBalanceLimitFailureCode } from './migration-20261003140000-allow-balance-limit-failure-code';

export const migrations = [
  Migration20261002120000CreateWageringSchema,
  Migration20261003140000AllowBalanceLimitFailureCode,
];
