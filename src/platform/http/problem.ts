import { HttpException } from '@nestjs/common';
import { ApplicationError } from '@shared/application/application-error';
import { TransientFailure } from '@shared/application/transient-failure';
import { DomainError } from '@shared/domain/domain-error';
import { RequestValidationError, type ValidationIssue } from './request-errors';

export interface ProblemFieldError {
  path: string;
  message: string;
}

export interface HttpProblem {
  status: number;
  code: string;
  title: string;
  retryable: boolean;
  errors?: ProblemFieldError[];
  headers?: Record<string, string>;
}

interface ProblemType {
  status: number;
  title: string;
  retryable: boolean;
}

const PROBLEM_TYPES: Readonly<Record<string, ProblemType>> = {
  INVALID_PAYLOAD: { status: 400, title: 'The request body is invalid', retryable: false },
  INVALID_REQUEST: { status: 400, title: 'The request is invalid', retryable: false },
  INVALID_CURSOR: { status: 400, title: 'The ledger cursor is not valid for this wallet', retryable: false },
  IDEMPOTENCY_KEY_REQUIRED: { status: 400, title: 'A valid Idempotency-Key header is required', retryable: false },
  UNSUPPORTED_KIND: { status: 400, title: 'OPENING is internal and cannot be submitted', retryable: false },
  REFERENCE_REQUIRED: { status: 400, title: 'REFUND and ROLLBACK require a reference', retryable: false },
  REFERENCE_NOT_ALLOWED: { status: 400, title: 'BET cannot reference another transaction', retryable: false },
  INVALID_AMOUNT: { status: 400, title: 'Only LOSS accepts a zero amount', retryable: false },
  NOT_FOUND: { status: 404, title: 'Resource not found', retryable: false },
  WALLET_NOT_FOUND: { status: 404, title: 'Wallet not found', retryable: false },
  TRANSACTION_NOT_FOUND: { status: 404, title: 'Wager transaction not found', retryable: false },
  WALLET_ALREADY_EXISTS: { status: 409, title: 'The player already has a wallet in this currency', retryable: false },
  IDEMPOTENCY_KEY_CONFLICT: { status: 409, title: 'Idempotency key reused with a different payload', retryable: false },
  EXTERNAL_TRANSACTION_CONFLICT: {
    status: 409,
    title: 'External transaction id already used with another idempotency key',
    retryable: false,
  },
  DUPLICATE_WAGER_TRANSACTION: { status: 409, title: 'A concurrent request created the same transaction', retryable: true },
  PAYLOAD_TOO_LARGE: { status: 413, title: 'The request body is too large', retryable: false },
  INTERNAL_ERROR: { status: 500, title: 'Unexpected error; nothing was committed', retryable: true },
  SERVICE_UNAVAILABLE: { status: 503, title: 'The service is temporarily unavailable', retryable: true },
};

const ALIASES: Readonly<Record<string, string>> = {
  INVALID_MONEY: 'INVALID_PAYLOAD',
};

const PUBLIC_DOMAIN_CODES = new Set(Object.keys(PROBLEM_TYPES).filter((code) => code !== 'SERVICE_UNAVAILABLE'));

export function problemFor(error: unknown): HttpProblem {
  if (error instanceof TransientFailure) {
    return problem('SERVICE_UNAVAILABLE', { headers: { 'retry-after': '1' } });
  }
  if (error instanceof RequestValidationError) {
    return problem(error.code, { errors: error.issues.map(toFieldError) });
  }
  if (error instanceof DomainError || error instanceof ApplicationError) {
    const code = ALIASES[error.code] ?? error.code;
    return problem(PUBLIC_DOMAIN_CODES.has(code) ? code : 'INTERNAL_ERROR');
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return status >= 500 ? problem('INTERNAL_ERROR') : { ...problem(codeForStatus(status)), status };
  }
  return problem('INTERNAL_ERROR');
}

function problem(code: string, extra: Pick<HttpProblem, 'errors' | 'headers'> = {}): HttpProblem {
  const type = PROBLEM_TYPES[code] ?? PROBLEM_TYPES.INTERNAL_ERROR!;
  return { status: type.status, code: code in PROBLEM_TYPES ? code : 'INTERNAL_ERROR', title: type.title, retryable: type.retryable, ...extra };
}

function codeForStatus(status: number): string {
  if (status === 400) {
    return 'INVALID_PAYLOAD';
  }
  if (status === 404) {
    return 'NOT_FOUND';
  }
  if (status === 413) {
    return 'PAYLOAD_TOO_LARGE';
  }
  return 'INVALID_REQUEST';
}

function toFieldError(issue: ValidationIssue): ProblemFieldError {
  const path = (issue.path ?? [])
    .map((segment) => String(typeof segment === 'object' && segment !== null ? segment.key : segment))
    .join('.');
  return { path, message: issue.message };
}
