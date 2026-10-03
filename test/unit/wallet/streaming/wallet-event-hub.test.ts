import { describe, expect, test } from 'bun:test';
import { RequestValidationError } from '@platform/http/request-errors';
import { silentLogger } from '@shared/application/logger';
import { WalletNotFoundError } from '@wallet/application/errors';
import type { LedgerEntryView, WalletView } from '@wallet/application/views';
import { StreamCapacityExceededError } from '@wallet/infrastructure/streaming/stream-errors';
import {
  type EventSink,
  type WalletEventFeed,
  WalletEventHub,
  type WalletEventHubSettings,
} from '@wallet/infrastructure/streaming/wallet-event-hub';
import { waitUntil } from '@test/support/async';
import { RecordingMetrics } from '@test/support/recording-metrics';
import { parseServerSentEvents } from '@test/support/sse';

const AT = new Date('2026-10-03T12:00:00.000Z');
const brl = (amount: string) => ({ amount, currency: 'BRL' });

function entry(walletVersion: number): LedgerEntryView {
  return {
    id: Bun.randomUUIDv7(),
    transactionId: Bun.randomUUIDv7(),
    direction: 'CREDIT',
    money: brl('1.00'),
    balanceBefore: brl('10.00'),
    balanceAfter: brl('11.00'),
    walletVersion,
    createdAt: new Date(),
  };
}

class FakeFeed implements WalletEventFeed {
  readonly wallets = new Map<string, WalletView>();
  readonly ledgers = new Map<string, LedgerEntryView[]>();
  failures = 0;
  delayMs = 0;
  ledgerReads = 0;

  open(version = 1): string {
    const id = Bun.randomUUIDv7();
    this.wallets.set(id, {
      id,
      playerId: Bun.randomUUIDv7(),
      balance: brl('10.00'),
      version,
      createdAt: AT,
      updatedAt: AT,
    });
    this.ledgers.set(id, []);
    return id;
  }

  append(walletId: string, count = 1): void {
    const wallet = this.wallets.get(walletId)!;
    for (let index = 0; index < count; index += 1) {
      wallet.version += 1;
      this.ledgers.get(walletId)!.push(entry(wallet.version));
    }
  }

  async getWallet(walletId: string): Promise<WalletView> {
    const wallet = this.wallets.get(walletId);
    if (wallet === undefined) {
      throw new WalletNotFoundError(walletId);
    }
    return { ...wallet };
  }

  async getLedgerAfter(
    walletId: string,
    afterVersion: number,
    limit: number,
  ): Promise<LedgerEntryView[]> {
    this.ledgerReads += 1;
    if (this.delayMs > 0) {
      await Bun.sleep(this.delayMs);
    }
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('database unavailable');
    }
    return (this.ledgers.get(walletId) ?? [])
      .filter((item) => item.walletVersion > afterVersion)
      .slice(0, limit);
  }

  async getWalletVersions(
    walletIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    return new Map(
      walletIds.flatMap((id) => {
        const wallet = this.wallets.get(id);
        return wallet === undefined ? [] : [[id, wallet.version] as const];
      }),
    );
  }
}

class FakeSink implements EventSink {
  readonly chunks: string[] = [];
  opened = false;
  ended = false;
  accepting = true;
  private readonly drains: (() => void)[] = [];
  private readonly closes: (() => void)[] = [];

  open(): void {
    this.opened = true;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return this.accepting;
  }

  onDrain(listener: () => void): void {
    this.drains.push(listener);
  }

  onClose(listener: () => void): void {
    this.closes.push(listener);
  }

  end(): void {
    if (!this.ended) {
      this.ended = true;
      this.disconnect();
    }
  }

  drain(): void {
    this.accepting = true;
    for (const listener of this.drains.splice(0)) {
      listener();
    }
  }

  disconnect(): void {
    for (const listener of this.closes.splice(0)) {
      listener();
    }
  }

  get stream() {
    return parseServerSentEvents(this.chunks.join(''));
  }

  versions(): number[] {
    return this.stream.events
      .filter((event) => event.event === 'ledger-entry')
      .map((event) => event.data.walletVersion);
  }
}

const inAMinute = () => new Date(Date.now() + 60_000);

function setup(overrides: Partial<WalletEventHubSettings> = {}) {
  const feed = new FakeFeed();
  const metrics = new RecordingMetrics();
  const hub = new WalletEventHub(
    feed,
    {
      maxStreams: 3,
      pageSize: 2,
      retryMs: 1500,
      sweepIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      ...overrides,
    },
    metrics,
    silentLogger,
  );
  const subscribe = async (
    walletId: string,
    lastEventId?: number,
    expiresAt = inAMinute(),
  ) => {
    const sink = new FakeSink();
    await hub.open({ walletId, lastEventId, expiresAt, sink });
    return sink;
  };
  return { feed, metrics, hub, subscribe };
}

describe('WalletEventHub', () => {
  test('opens a new subscription with the retry delay and a wallet snapshot', async () => {
    const { feed, hub, subscribe } = setup();
    const walletId = feed.open(4);

    const sink = await subscribe(walletId);

    expect(sink.opened).toBe(true);
    expect(sink.stream.retry).toBe(1500);
    expect(sink.stream.events).toEqual([
      {
        id: '4',
        event: 'wallet',
        data: expect.objectContaining({ id: walletId, version: 4 }),
      },
    ]);
    expect(hub.openStreams).toBe(1);
  });

  test('replays the entries after Last-Event-ID in order, without a snapshot', async () => {
    const { feed, subscribe } = setup();
    const walletId = feed.open(1);
    feed.append(walletId, 5);

    const sink = await subscribe(walletId, 3);

    await waitUntil(() => sink.versions().length === 3);
    expect(sink.versions()).toEqual([4, 5, 6]);
    expect(sink.stream.events.map((event) => event.id)).toEqual([
      '4',
      '5',
      '6',
    ]);
    expect(sink.stream.events[0]?.data.walletId).toBe(walletId);
  });

  test('refuses a Last-Event-ID ahead of the wallet and writes nothing', async () => {
    const { feed, hub } = setup();
    const walletId = feed.open(3);
    const sink = new FakeSink();

    await expect(
      hub.open({ walletId, lastEventId: 4, expiresAt: inAMinute(), sink }),
    ).rejects.toBeInstanceOf(RequestValidationError);
    expect(sink.opened).toBe(false);
    expect(hub.openStreams).toBe(0);
  });

  test('refuses a wallet that does not exist', async () => {
    const { hub } = setup();
    const sink = new FakeSink();

    await expect(
      hub.open({
        walletId: Bun.randomUUIDv7(),
        lastEventId: undefined,
        expiresAt: inAMinute(),
        sink,
      }),
    ).rejects.toBeInstanceOf(WalletNotFoundError);
    expect(sink.opened).toBe(false);
  });

  test('refuses streams beyond its capacity', async () => {
    const { feed, hub, subscribe } = setup({ maxStreams: 2 });
    const walletId = feed.open();
    await subscribe(walletId);
    await subscribe(walletId);
    const sink = new FakeSink();

    await expect(
      hub.open({
        walletId,
        lastEventId: undefined,
        expiresAt: inAMinute(),
        sink,
      }),
    ).rejects.toBeInstanceOf(StreamCapacityExceededError);
    expect(sink.opened).toBe(false);
    expect(hub.openStreams).toBe(2);
  });

  test('delivers each new entry once, in order, to every subscriber of the wallet', async () => {
    const { feed, hub, subscribe } = setup();
    const walletId = feed.open(1);
    const live = await subscribe(walletId);
    const resumed = await subscribe(walletId, 1);
    feed.append(walletId, 3);

    hub.wake(walletId);
    await waitUntil(
      () => live.versions().length === 3 && resumed.versions().length === 3,
    );
    hub.wake(walletId);
    await Bun.sleep(30);

    expect(live.versions()).toEqual([2, 3, 4]);
    expect(resumed.versions()).toEqual([2, 3, 4]);
  });

  test("keeps another wallet's entries out of the stream", async () => {
    const { feed, hub, subscribe } = setup();
    const watched = feed.open();
    const other = feed.open();
    const sink = await subscribe(watched);
    feed.append(other, 2);

    hub.wake(other);
    hub.wake(watched);
    await Bun.sleep(30);

    expect(sink.versions()).toEqual([]);
  });

  test('stops writing to a slow client and resumes from its cursor after drain', async () => {
    const { feed, hub, subscribe } = setup();
    const walletId = feed.open(1);
    const sink = await subscribe(walletId);
    sink.accepting = false;
    feed.append(walletId, 3);

    hub.wake(walletId);
    await waitUntil(() => sink.versions().length === 1);
    await Bun.sleep(30);
    expect(sink.versions()).toEqual([2]);

    sink.drain();
    await waitUntil(() => sink.versions().length === 3);
    expect(sink.versions()).toEqual([2, 3, 4]);
  });

  test('sweeps the wallets whose version moved past their subscribers', async () => {
    const { feed, hub, subscribe } = setup();
    const walletId = feed.open(1);
    const sink = await subscribe(walletId);
    feed.append(walletId, 2);

    await hub.sweep();

    await waitUntil(() => sink.versions().length === 2);
    expect(sink.versions()).toEqual([2, 3]);
  });

  test('does not read the ledger in a sweep when nothing changed', async () => {
    const { feed, hub, subscribe } = setup();
    const walletId = feed.open(1);
    await subscribe(walletId);
    await waitUntil(() => feed.ledgerReads === 1);

    await hub.sweep();
    await Bun.sleep(30);

    expect(feed.ledgerReads).toBe(1);
  });

  test('sends keep-alive comments', async () => {
    const { feed, hub, subscribe } = setup();
    const sink = await subscribe(feed.open());

    hub.heartbeat();

    expect(sink.stream.comments).toBe(1);
  });

  test('ends the stream when the token expires', async () => {
    const { feed, hub, subscribe } = setup();
    const sink = await subscribe(
      feed.open(),
      undefined,
      new Date(Date.now() + 50),
    );

    await waitUntil(() => sink.ended);
    expect(hub.openStreams).toBe(0);
  });

  test('forgets a subscriber whose client went away', async () => {
    const { feed, hub, subscribe } = setup();
    const walletId = feed.open(1);
    const sink = await subscribe(walletId);
    const written = sink.chunks.length;

    sink.disconnect();
    feed.append(walletId, 2);
    hub.wake(walletId);
    await Bun.sleep(30);

    expect(hub.openStreams).toBe(0);
    expect(sink.chunks).toHaveLength(written);
  });

  test('closes every stream on shutdown', async () => {
    const { feed, hub, subscribe } = setup();
    const first = await subscribe(feed.open());
    const second = await subscribe(feed.open());

    hub.stop();

    expect([first.ended, second.ended]).toEqual([true, true]);
    expect(hub.openStreams).toBe(0);
  });

  test('refuses new streams once it stopped', async () => {
    const { feed, hub } = setup();
    const walletId = feed.open();
    hub.stop();
    const sink = new FakeSink();

    await expect(
      hub.open({
        walletId,
        lastEventId: undefined,
        expiresAt: inAMinute(),
        sink,
      }),
    ).rejects.toBeInstanceOf(StreamCapacityExceededError);
    expect(sink.opened).toBe(false);
  });

  test('starts with the application and stops before it shuts down', async () => {
    const { feed, hub, subscribe } = setup({
      sweepIntervalMs: 10,
      heartbeatIntervalMs: 10,
    });
    const walletId = feed.open(1);
    const sink = await subscribe(walletId);
    feed.append(walletId, 1);

    hub.onApplicationBootstrap();
    await waitUntil(
      () => sink.versions().length === 1 && sink.stream.comments > 0,
    );
    hub.beforeApplicationShutdown();

    expect(sink.ended).toBe(true);
    expect(sink.versions()).toEqual([2]);
  });

  test('does not repeat entries when wake-ups overlap', async () => {
    const { feed, hub, subscribe } = setup();
    const walletId = feed.open(1);
    const sink = await subscribe(walletId);
    feed.delayMs = 20;
    feed.append(walletId, 3);

    hub.wake(walletId);
    hub.wake(walletId);
    hub.wake(walletId);
    await waitUntil(() => sink.versions().length >= 3);
    await Bun.sleep(100);

    expect(sink.versions()).toEqual([2, 3, 4]);
  });

  test('recovers on the next sweep after a failed read', async () => {
    const { feed, hub, subscribe } = setup();
    const walletId = feed.open(1);
    const sink = await subscribe(walletId);
    await waitUntil(() => feed.ledgerReads === 1);
    feed.failures = 1;
    feed.append(walletId, 2);

    hub.wake(walletId);
    await waitUntil(() => feed.ledgerReads === 2);
    await Bun.sleep(20);
    expect(sink.versions()).toEqual([]);

    await hub.sweep();
    await waitUntil(() => sink.versions().length === 2);
    expect(sink.versions()).toEqual([2, 3]);
  });

  test('measures open streams and delivered events', async () => {
    const { feed, hub, metrics, subscribe } = setup();
    const walletId = feed.open(1);
    const sink = await subscribe(walletId);
    feed.append(walletId, 2);

    hub.wake(walletId);
    await waitUntil(() => sink.versions().length === 2);
    sink.disconnect();

    expect(
      metrics.gauges
        .filter((gauge) => gauge.name === 'wallet_event_streams')
        .map((gauge) => gauge.value),
    ).toEqual([1, 0]);
    expect(metrics.count('wallet_events_streamed_total')).toBe(2);
    expect(metrics.observed('wallet_event_delivery_seconds')).toHaveLength(2);
  });
});
