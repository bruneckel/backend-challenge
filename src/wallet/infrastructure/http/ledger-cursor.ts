import { ApplicationError } from '@shared/application/application-error';
import { z } from 'zod';

export class InvalidCursorError extends ApplicationError {
  override readonly code = 'INVALID_CURSOR';

  constructor() {
    super('The ledger cursor is not valid for this wallet');
  }
}

const cursorSchema = z.object({ walletId: z.string(), beforeVersion: z.number().int().min(2) }).strict();

export function encodeLedgerCursor(walletId: string, beforeVersion: number): string {
  return Buffer.from(JSON.stringify({ walletId, beforeVersion })).toString('base64url');
}

export function decodeLedgerCursor(cursor: string, walletId: string): number {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new InvalidCursorError();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  const parsed = cursorSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.walletId !== walletId) {
    throw new InvalidCursorError();
  }
  return parsed.data.beforeVersion;
}
