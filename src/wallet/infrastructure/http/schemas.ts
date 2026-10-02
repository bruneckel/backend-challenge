import { z } from 'zod';

const visibleAscii = (max: number) =>
  z.string().regex(new RegExp(`^[\\x21-\\x7e]{1,${max}}$`), `must be 1 to ${max} visible ASCII characters`);

const PROVIDER_ID = /^[A-Za-z0-9._:-]{1,64}$/;

export const moneySchema = z
  .object({
    amount: z
      .string()
      .regex(/^(0|[1-9]\d{0,16})\.\d{2}$/, 'must be a decimal string with two decimals and at most 17 integer digits'),
    currency: z.string().regex(/^[A-Z]{3}$/, 'must be a three-letter uppercase ISO-4217 code'),
  })
  .strict();

export const openWalletSchema = z.object({ playerId: z.uuid(), initialBalance: moneySchema }).strict();

export type OpenWalletBody = z.infer<typeof openWalletSchema>;

export const wagerOperationSchema = z
  .object({
    providerId: z
      .string()
      .regex(PROVIDER_ID, 'must be 1 to 64 characters among letters, digits and . _ : -')
      .refine((value) => value !== 'internal', 'internal is reserved for wallet openings'),
    externalTransactionId: visibleAscii(128),
    playerId: z.uuid(),
    walletId: z.uuid(),
    roundId: visibleAscii(128),
    gameId: visibleAscii(128),
    kind: z.enum(['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
    money: moneySchema,
    referenceExternalTransactionId: visibleAscii(128).optional(),
  })
  .strict();

export type WagerOperationBody = z.infer<typeof wagerOperationSchema>;

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
