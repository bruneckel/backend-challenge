import { describe, expect, test } from 'bun:test';
import {
  type InboundMessage,
  inboxMessagePayload,
} from '@messaging/application/inbound-message';
import { CanonicalJsonFingerprinter } from '@platform/crypto/canonical-json-fingerprinter';

const fingerprinter = new CanonicalJsonFingerprinter();

const message: InboundMessage = {
  messageId: 'msg-123',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  },
};

const hashOf = (value: InboundMessage) =>
  fingerprinter.fingerprint(inboxMessagePayload(value));

describe('inbox message fingerprint', () => {
  test('matches the documented SHA-256 of the canonical type and data', () => {
    expect(hashOf(message)).toBe(
      'c0c6bae37f6ceee9f633907ef9c19bdbf43fbf3570e3bf0a66a09dda29ef9437',
    );
  });

  test('ignores the message id and the time the message was sent', () => {
    expect(
      hashOf({
        ...message,
        messageId: 'msg-999',
        occurredAt: '2026-07-30T00:00:00.000Z',
      }),
    ).toBe(hashOf(message));
  });

  test('includes the idempotency key carried in the data', () => {
    const otherKey = {
      ...message,
      data: { ...message.data, idempotencyKey: 'provider-a:transaction-999' },
    };

    expect(hashOf(otherKey)).not.toBe(hashOf(message));
  });

  test('includes the message type', () => {
    expect(hashOf({ ...message, type: 'SomethingElse' })).not.toBe(
      hashOf(message),
    );
  });
});
