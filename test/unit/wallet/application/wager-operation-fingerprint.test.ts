import { describe, expect, test } from 'bun:test';
import { CanonicalJsonFingerprinter } from '@platform/crypto/canonical-json-fingerprinter';
import {
  type WagerOperation,
  wagerOperationPayload,
} from '@wallet/application/wager-operation';

const fingerprinter = new CanonicalJsonFingerprinter();

const operation: WagerOperation = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

const hashOf = (value: WagerOperation) =>
  fingerprinter.fingerprint(wagerOperationPayload(value));

describe('wager operation fingerprint', () => {
  test('matches the documented SHA-256 of the RFC 8785 canonical JSON', () => {
    expect(hashOf(operation)).toBe(
      '629836932b79106b99523d06a1e7fa80689b0ea1e1c47aa3f0a5a2c87d0c4344',
    );
  });

  test('ignores the order of the fields', () => {
    const reordered: WagerOperation = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'fortune-chimp',
      roundId: 'round-987',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
    };

    expect(hashOf(reordered)).toBe(hashOf(operation));
  });

  test('ignores transport fields such as the idempotency key, message id and correlation id', () => {
    const withTransport = {
      ...operation,
      idempotencyKey: 'another-key',
      messageId: 'msg-123',
      type: 'WagerTransactionRequested',
      occurredAt: '2026-07-29T15:00:00.000Z',
      correlationId: 'correlation-1',
    };

    expect(hashOf(withTransport)).toBe(hashOf(operation));
  });

  test('omits an absent reference instead of hashing it as null', () => {
    expect(
      hashOf({ ...operation, referenceExternalTransactionId: undefined }),
    ).toBe(hashOf(operation));
  });

  test.each([
    ['providerId', { providerId: 'provider-b' }],
    ['externalTransactionId', { externalTransactionId: 'transaction-124' }],
    ['playerId', { playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a2' }],
    ['walletId', { walletId: '0192f291-27dd-7d3f-8071-5f8685deef38' }],
    ['roundId', { roundId: 'round-988' }],
    ['gameId', { gameId: 'other-game' }],
    ['kind', { kind: 'WIN' }],
    ['amount', { money: { amount: '25.01', currency: 'BRL' } }],
    ['currency', { money: { amount: '25.00', currency: 'USD' } }],
    ['reference', { referenceExternalTransactionId: 'transaction-122' }],
  ] as const)('treats a different %s as a different operation', (_, change) => {
    expect(hashOf({ ...operation, ...change })).not.toBe(hashOf(operation));
  });
});
