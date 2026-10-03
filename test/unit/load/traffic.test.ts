import { describe, expect, test } from 'bun:test';
import {
  OperationFactory,
  outcomeOfError,
  outcomeOfStatus,
} from '@test/load/traffic';

describe('outcomeOfStatus', () => {
  test.each([
    [200, false, 'ok'],
    [202, false, 'ok'],
    [200, true, 'replay'],
    [422, false, 'rejected'],
    [409, false, 'conflict'],
    [400, false, 'client_error'],
    [404, false, 'client_error'],
    [503, false, 'unavailable'],
    [500, false, 'server_error'],
  ] as const)('classifies %i (replay %p) as %s', (status, replay, outcome) => {
    expect(outcomeOfStatus(status, replay)).toBe(outcome);
  });
});

describe('outcomeOfError', () => {
  test('tells a client timeout from a broken connection', () => {
    expect(outcomeOfError(new DOMException('late', 'TimeoutError'))).toBe(
      'timeout',
    );
    expect(outcomeOfError(new TypeError('socket closed'))).toBe(
      'network_error',
    );
  });
});

describe('OperationFactory', () => {
  const wallets = Array.from({ length: 4 }, (_, index) => ({
    id: `wallet-${index}`,
    playerId: `player-${index}`,
  }));
  const hot = { id: 'hot', playerId: 'hot-player' };

  test('sends the hot share of the operations to the hot wallet', () => {
    const factory = new OperationFactory({
      wallets,
      hot,
      hotShare: 0.25,
      replayShare: 0,
      random: sequence([0.1, 0.0, 0.5, 0.3, 0.9, 0.6, 0.8, 0.2, 0.2, 0.7]),
    });

    const targets = Array.from(
      { length: 4 },
      () => factory.next().body.walletId,
    );

    expect(targets).toEqual(['hot', 'wallet-1', 'wallet-3', 'hot']);
  });

  test('never touches the hot wallet when the share is zero', () => {
    const factory = new OperationFactory({
      wallets,
      hot,
      hotShare: 0,
      replayShare: 0,
    });

    const targets = new Set(
      Array.from({ length: 200 }, () => factory.next().body.walletId),
    );

    expect(targets.has('hot')).toBe(false);
  });

  test('replays an operation it already produced, with the same key and body', () => {
    const factory = new OperationFactory({
      wallets,
      hot,
      hotShare: 0,
      replayShare: 0.5,
      random: sequence([0.9, 0.5, 0.5, 0.2, 0.0]),
    });

    const first = factory.next();
    const second = factory.next();

    expect(second).toEqual(first);
    expect(factory.replays).toBe(1);
  });

  test('alternates BET and WIN of one unit so balances stay level', () => {
    const factory = new OperationFactory({
      wallets,
      hot,
      hotShare: 0,
      replayShare: 0,
    });

    const operations = Array.from({ length: 50 }, () => factory.next());

    expect(new Set(operations.map((operation) => operation.body.kind))).toEqual(
      new Set(['BET', 'WIN']),
    );
    expect(
      operations.every((operation) => operation.body.money.amount === '1.00'),
    ).toBe(true);
  });
});

function sequence(values: number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length]!;
}
