import { describe, expect, test } from 'bun:test';
import { classifyDatabaseError } from '@platform/database/database-failure';

describe('classifyDatabaseError', () => {
  test.each([
    ['a unique violation', { code: '23505', constraint: 'wallets_player_currency_key' }, { kind: 'unique_violation', constraint: 'wallets_player_currency_key' }],
    ['a foreign key violation', { code: '23503', constraint: 'wager_transactions_wallet_fkey' }, { kind: 'foreign_key_violation', constraint: 'wager_transactions_wallet_fkey' }],
    ['a check violation', { code: '23514', constraint: 'wallets_balance_amount_money' }, { kind: 'check_violation', constraint: 'wallets_balance_amount_money' }],
    ['a not null violation', { code: '23502' }, { kind: 'not_null_violation' }],
    ['a trigger refusing a mutation', { code: '23001' }, { kind: 'restrict_violation' }],
    ['a lock timeout', { code: '55P03' }, { kind: 'transient', reason: 'lock_timeout' }],
    ['a deadlock', { code: '40P01' }, { kind: 'transient', reason: 'deadlock' }],
    ['a serialization failure', { code: '40001' }, { kind: 'transient', reason: 'serialization_failure' }],
    ['a statement timeout', { code: '57014' }, { kind: 'transient', reason: 'statement_timeout' }],
    ['a broken connection', { code: '08006' }, { kind: 'transient', reason: 'connection' }],
    ['a connection that could not be established', { code: '08001' }, { kind: 'transient', reason: 'connection' }],
    ['a server shutting down', { code: '57P01' }, { kind: 'transient', reason: 'connection' }],
    ['a server not accepting connections yet', { code: '57P03' }, { kind: 'transient', reason: 'connection' }],
    ['too many connections', { code: '53300' }, { kind: 'transient', reason: 'connection' }],
    ['a session killed for idling in a transaction', { code: '25P03' }, { kind: 'transient', reason: 'connection' }],
    ['a refused socket', { code: 'ECONNREFUSED' }, { kind: 'transient', reason: 'connection' }],
    ['a reset socket', { code: 'ECONNRESET' }, { kind: 'transient', reason: 'connection' }],
    ['a socket timeout', { code: 'ETIMEDOUT' }, { kind: 'transient', reason: 'connection' }],
    ['an unrelated SQL error', { code: '42P01' }, { kind: 'unknown' }],
    ['an error without a code', new Error('boom'), { kind: 'unknown' }],
    ['a thrown string', 'boom', { kind: 'unknown' }],
    ['a thrown null', null, { kind: 'unknown' }],
  ] as const)('classifies %s', (_, error, expected) => {
    expect(classifyDatabaseError(error)).toEqual(expected);
  });

  test('keeps the constraint undefined when the driver does not name it', () => {
    expect(classifyDatabaseError({ code: '23505' })).toEqual({ kind: 'unique_violation', constraint: undefined });
  });
});
