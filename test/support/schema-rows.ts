import type { Row } from './database';

export const AT = new Date('2026-10-02T12:00:00.000Z');
export const LATER = new Date('2026-10-02T12:05:00.000Z');
export const HASH = 'a'.repeat(64);

export function walletRow(overrides: Row = {}): Row {
  return {
    id: Bun.randomUUIDv7(),
    player_id: Bun.randomUUIDv7(),
    currency: 'BRL',
    balance_amount: '100.00',
    version: 1,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
}

export function transactionRow(wallet: Row, overrides: Row = {}): Row {
  const externalTransactionId = `ext-${Bun.randomUUIDv7()}`;
  return {
    id: Bun.randomUUIDv7(),
    provider_id: 'provider-a',
    external_transaction_id: externalTransactionId,
    idempotency_key: `provider-a:${externalTransactionId}`,
    payload_hash: HASH,
    wallet_id: wallet.id,
    player_id: wallet.player_id,
    round_id: 'round-1',
    game_id: 'fortune-chimp',
    kind: 'BET',
    amount: '10.00',
    currency: wallet.currency,
    reference_external_transaction_id: null,
    correlation_id: 'correlation-1',
    status: 'PROCESSED',
    failure_code: null,
    reference_transaction_id: null,
    processed_at: AT,
    result_balance_amount: '90.00',
    result_balance_currency: wallet.currency,
    reference_attempts: 0,
    next_reference_attempt_at: null,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
}

export const rejected: Row = {
  status: 'REJECTED',
  failure_code: 'INSUFFICIENT_FUNDS',
  processed_at: null,
};

export const failed: Row = {
  status: 'FAILED',
  failure_code: 'PROCESSING_FAILED',
  processed_at: null,
  result_balance_amount: null,
  result_balance_currency: null,
};

export const pendingReference: Row = {
  status: 'PENDING_REFERENCE',
  kind: 'REFUND',
  reference_external_transaction_id: 'ext-missing',
  processed_at: null,
  next_reference_attempt_at: LATER,
};

export function referencing(
  reference: Row,
  kind: 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK',
  overrides: Row = {},
): Row {
  return {
    kind,
    amount: reference.amount,
    reference_external_transaction_id: reference.external_transaction_id,
    reference_transaction_id: reference.id,
    ...overrides,
  };
}

export function openingOf(wallet: Row, overrides: Row = {}): Row {
  const reference = `opening:${String(wallet.id)}`;
  return {
    kind: 'OPENING',
    provider_id: 'internal',
    external_transaction_id: reference,
    idempotency_key: reference,
    round_id: 'opening',
    game_id: 'internal',
    amount: wallet.balance_amount,
    result_balance_amount: wallet.balance_amount,
    ...overrides,
  };
}

export function ledgerRow(transaction: Row, overrides: Row = {}): Row {
  return {
    id: Bun.randomUUIDv7(),
    wallet_id: transaction.wallet_id,
    transaction_id: transaction.id,
    wallet_version: 2,
    direction: 'DEBIT',
    amount: '10.00',
    currency: transaction.currency,
    balance_before: '100.00',
    balance_after: '90.00',
    created_at: AT,
    ...overrides,
  };
}

export function inboxRow(overrides: Row = {}): Row {
  return {
    consumer_name: 'wager-commands',
    message_id: Bun.randomUUIDv7(),
    payload_hash: HASH,
    transaction_id: null,
    received_at: AT,
    processed_at: null,
    ...overrides,
  };
}

export function outboxRow(overrides: Row = {}): Row {
  const aggregateId = Bun.randomUUIDv7();
  return {
    id: Bun.randomUUIDv7(),
    aggregate_id: aggregateId,
    event_type: 'WagerTransactionProcessed',
    event_version: 1,
    message_group_id: aggregateId,
    payload: { eventId: 'event-1', data: { amount: '10.00' } },
    occurred_at: AT,
    attempts: 0,
    next_attempt_at: AT,
    published_at: null,
    last_error: null,
    ...overrides,
  };
}

export function requiredColumns(
  row: Row,
  nullable: readonly string[] = [],
): string[] {
  return Object.keys(row).filter((column) => !nullable.includes(column));
}
