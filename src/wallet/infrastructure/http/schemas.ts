import { z } from 'zod';
import {
  PROVIDER_ID,
  moneySchema,
  visibleAscii,
} from '@wallet/infrastructure/contracts/wager-operation.schema';

export {
  type WagerOperationBody,
  wagerOperationSchema,
} from '@wallet/infrastructure/contracts/wager-operation.schema';

export const openWalletSchema = z
  .object({ playerId: z.uuid(), initialBalance: moneySchema })
  .strict();

export type OpenWalletBody = z.infer<typeof openWalletSchema>;

export const uuidParam = z.uuid();

export const providerIdParam = z.string().regex(PROVIDER_ID);

export const externalTransactionIdParam = visibleAscii(128);

export const ledgerQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export type LedgerQueryParams = z.infer<typeof ledgerQuerySchema>;
