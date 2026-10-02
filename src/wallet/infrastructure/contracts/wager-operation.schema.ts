import { z } from 'zod';

export const visibleAscii = (max: number) =>
  z
    .string()
    .regex(
      new RegExp(`^[\\x21-\\x7e]{1,${max}}$`),
      `must be 1 to ${max} visible ASCII characters`,
    );

export const PROVIDER_ID = /^[A-Za-z0-9._:-]{1,64}$/;

export const moneySchema = z
  .object({
    amount: z
      .string()
      .regex(
        /^(0|[1-9]\d{0,16})\.\d{2}$/,
        'must be a decimal string with two decimals and at most 17 integer digits',
      ),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, 'must be a three-letter uppercase ISO-4217 code'),
  })
  .strict();

export const wagerOperationSchema = z
  .object({
    providerId: z
      .string()
      .regex(
        PROVIDER_ID,
        'must be 1 to 64 characters among letters, digits and . _ : -',
      )
      .refine(
        (value) => value !== 'internal',
        'internal is reserved for wallet openings',
      ),
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

export const wagerTransactionRequestedSchema = z
  .object({
    messageId: visibleAscii(255),
    type: z.literal('WagerTransactionRequested'),
    occurredAt: z.iso.datetime(),
    data: wagerOperationSchema
      .extend({ idempotencyKey: visibleAscii(255) })
      .strict(),
  })
  .strict();

export type WagerTransactionRequested = z.infer<
  typeof wagerTransactionRequestedSchema
>;
