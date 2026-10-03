import { describe, expect, test } from 'bun:test';
import { StreamTracker } from '@test/load/streams';

const createdAt = (ms: number) => new Date(ms).toISOString();

describe('StreamTracker', () => {
  test('follows a stream that starts with a snapshot and grows one version at a time', () => {
    const tracker = new StreamTracker('wallet-1');

    tracker.receive({ id: '3', event: 'wallet', data: { version: 3 } }, 1000);
    tracker.receive(
      {
        id: '4',
        event: 'ledger-entry',
        data: { walletVersion: 4, createdAt: createdAt(900) },
      },
      1000,
    );
    tracker.receive(
      {
        id: '5',
        event: 'ledger-entry',
        data: { walletVersion: 5, createdAt: createdAt(950) },
      },
      1100,
    );

    expect(tracker.lastVersion).toBe(5);
    expect(tracker.entries).toBe(2);
    expect(tracker.gaps).toBe(0);
    expect(tracker.repeats).toBe(0);
    expect(tracker.latenciesMs).toEqual([100, 150]);
  });

  test('counts the versions skipped and the versions repeated', () => {
    const tracker = new StreamTracker('wallet-1');
    const entry = (version: number) => ({
      id: String(version),
      event: 'ledger-entry',
      data: { walletVersion: version, createdAt: createdAt(0) },
    });

    tracker.receive({ id: '1', event: 'wallet', data: { version: 1 } }, 0);
    for (const version of [2, 5, 5, 3, 6]) {
      tracker.receive(entry(version), 0);
    }

    expect(tracker.gaps).toBe(2);
    expect(tracker.repeats).toBe(2);
    expect(tracker.lastVersion).toBe(6);
  });

  test('reports how far it is behind the stored version', () => {
    const tracker = new StreamTracker('wallet-1');
    tracker.receive({ id: '7', event: 'wallet', data: { version: 7 } }, 0);

    expect(tracker.behind(7)).toBe(0);
    expect(tracker.behind(10)).toBe(3);
  });
});
