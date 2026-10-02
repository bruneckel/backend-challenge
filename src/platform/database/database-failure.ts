import type { TransientReason } from '@shared/application/transient-failure';

export type DatabaseFailure =
  | { kind: 'unique_violation'; constraint: string | undefined }
  | { kind: 'foreign_key_violation'; constraint: string | undefined }
  | { kind: 'check_violation'; constraint: string | undefined }
  | { kind: 'not_null_violation' }
  | { kind: 'restrict_violation' }
  | { kind: 'transient'; reason: TransientReason }
  | { kind: 'unknown' };

const TRANSIENT_CODES: Readonly<Record<string, TransientReason>> = {
  '55P03': 'lock_timeout',
  '40P01': 'deadlock',
  '40001': 'serialization_failure',
  '57014': 'statement_timeout',
  '57P01': 'connection',
  '57P02': 'connection',
  '57P03': 'connection',
  '53300': 'connection',
  '25P03': 'connection',
  ECONNREFUSED: 'connection',
  ECONNRESET: 'connection',
  ETIMEDOUT: 'connection',
  EPIPE: 'connection',
};

function fieldOf(error: unknown, field: string): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const value: unknown = Reflect.get(error, field);
  return typeof value === 'string' ? value : undefined;
}

export function classifyDatabaseError(error: unknown): DatabaseFailure {
  const code = fieldOf(error, 'code');
  const constraint = fieldOf(error, 'constraint');
  switch (code) {
    case '23505':
      return { kind: 'unique_violation', constraint };
    case '23503':
      return { kind: 'foreign_key_violation', constraint };
    case '23514':
      return { kind: 'check_violation', constraint };
    case '23502':
      return { kind: 'not_null_violation' };
    case '23001':
      return { kind: 'restrict_violation' };
  }
  if (code === undefined) {
    return { kind: 'unknown' };
  }
  const reason = TRANSIENT_CODES[code] ?? (code.startsWith('08') ? 'connection' : undefined);
  return reason === undefined ? { kind: 'unknown' } : { kind: 'transient', reason };
}
