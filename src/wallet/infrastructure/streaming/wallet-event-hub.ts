import type {
  BeforeApplicationShutdown,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { RequestValidationError } from '@platform/http/request-errors';
import type { Logger } from '@shared/application/logger';
import type { Metrics } from '@shared/application/metrics';
import type { LedgerEntryView, WalletView } from '@wallet/application/views';
import { KEEP_ALIVE, retryAfter, serverSentEvent } from './server-sent-events';
import { StreamCapacityExceededError } from './stream-errors';

export interface WalletEventFeed {
  getWallet(walletId: string): Promise<WalletView>;
  getLedgerAfter(
    walletId: string,
    afterVersion: number,
    limit: number,
  ): Promise<LedgerEntryView[]>;
  getWalletVersions(
    walletIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>>;
}

export interface EventSink {
  open(): void;
  write(chunk: string): boolean;
  onDrain(listener: () => void): void;
  onClose(listener: () => void): void;
  end(): void;
}

export interface StreamRequest {
  walletId: string;
  lastEventId: number | undefined;
  expiresAt: Date;
  sink: EventSink;
}

export interface WalletEventHubSettings {
  maxStreams: number;
  pageSize: number;
  retryMs: number;
  sweepIntervalMs: number;
  heartbeatIntervalMs: number;
}

interface Subscriber {
  readonly walletId: string;
  readonly sink: EventSink;
  cursor: number;
  paused: boolean;
  closed: boolean;
  expiry: ReturnType<typeof setTimeout> | undefined;
}

interface Channel {
  readonly subscribers: Set<Subscriber>;
  running: boolean;
  again: boolean;
}

const MAX_TIMER_MS = 2_147_483_647;

const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export class WalletEventHub
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly channels = new Map<string, Channel>();
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private streams = 0;
  private sweeping = false;
  private stopped = false;

  constructor(
    private readonly feed: WalletEventFeed,
    private readonly settings: WalletEventHubSettings,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  get openStreams(): number {
    return this.streams;
  }

  start(): void {
    this.timers.push(
      setInterval(() => void this.sweep(), this.settings.sweepIntervalMs),
      setInterval(() => this.heartbeat(), this.settings.heartbeatIntervalMs),
    );
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.splice(0)) {
      clearInterval(timer);
    }
    this.closeAll();
  }

  onApplicationBootstrap(): void {
    this.start();
  }

  beforeApplicationShutdown(): void {
    this.stop();
  }

  async open(request: StreamRequest): Promise<void> {
    this.assertCapacity();
    const wallet = await this.feed.getWallet(request.walletId);
    if (
      request.lastEventId !== undefined &&
      request.lastEventId > wallet.version
    ) {
      throw new RequestValidationError('header', [
        {
          message: 'is ahead of the wallet version',
          path: ['last-event-id'],
        },
      ]);
    }
    this.assertCapacity();
    const subscriber: Subscriber = {
      walletId: request.walletId,
      sink: request.sink,
      cursor: request.lastEventId ?? wallet.version,
      paused: false,
      closed: false,
      expiry: undefined,
    };
    request.sink.open();
    this.track(subscriber);
    request.sink.onClose(() => this.forget(subscriber));
    subscriber.expiry = setTimeout(
      () => this.end(subscriber),
      Math.min(
        MAX_TIMER_MS,
        Math.max(0, request.expiresAt.getTime() - Date.now()),
      ),
    );
    this.send(subscriber, retryAfter(this.settings.retryMs));
    if (request.lastEventId === undefined) {
      this.send(subscriber, serverSentEvent(wallet.version, 'wallet', wallet));
    }
    this.wake(request.walletId);
  }

  wake(walletId: string): void {
    const channel = this.channels.get(walletId);
    if (channel === undefined) {
      return;
    }
    if (channel.running) {
      channel.again = true;
      return;
    }
    channel.running = true;
    void this.deliver(walletId, channel);
  }

  async sweep(): Promise<void> {
    if (this.sweeping || this.channels.size === 0) {
      return;
    }
    this.sweeping = true;
    try {
      const versions = await this.feed.getWalletVersions([
        ...this.channels.keys(),
      ]);
      for (const [walletId, channel] of this.channels) {
        const version = versions.get(walletId) ?? 0;
        if (
          [...channel.subscribers].some(
            (subscriber) => !subscriber.paused && subscriber.cursor < version,
          )
        ) {
          this.wake(walletId);
        }
      }
    } catch (error) {
      this.logger.warn('wallet event sweep failed', {
        error: describe(error),
      });
    } finally {
      this.sweeping = false;
    }
  }

  heartbeat(): void {
    for (const channel of this.channels.values()) {
      for (const subscriber of channel.subscribers) {
        if (!subscriber.paused) {
          this.send(subscriber, KEEP_ALIVE);
        }
      }
    }
  }

  closeAll(): void {
    for (const channel of [...this.channels.values()]) {
      for (const subscriber of [...channel.subscribers]) {
        this.end(subscriber);
      }
    }
  }

  private async deliver(walletId: string, channel: Channel): Promise<void> {
    try {
      do {
        channel.again = false;
        await this.catchUp(walletId, channel);
      } while (channel.again);
    } catch (error) {
      this.logger.warn('wallet event delivery failed', {
        walletId,
        error: describe(error),
      });
    } finally {
      channel.running = false;
      if (
        channel.subscribers.size === 0 &&
        this.channels.get(walletId) === channel
      ) {
        this.channels.delete(walletId);
      }
    }
  }

  private async catchUp(walletId: string, channel: Channel): Promise<void> {
    for (;;) {
      const ready = [...channel.subscribers].filter(
        (subscriber) => !subscriber.paused,
      );
      if (ready.length === 0) {
        return;
      }
      const from = Math.min(...ready.map((subscriber) => subscriber.cursor));
      const entries = await this.feed.getLedgerAfter(
        walletId,
        from,
        this.settings.pageSize,
      );
      for (const entry of entries) {
        for (const subscriber of ready) {
          if (
            subscriber.paused ||
            subscriber.closed ||
            entry.walletVersion <= subscriber.cursor
          ) {
            continue;
          }
          subscriber.cursor = entry.walletVersion;
          this.send(
            subscriber,
            serverSentEvent(entry.walletVersion, 'ledger-entry', {
              walletId,
              ...entry,
            }),
          );
          this.metrics.increment('wallet_events_streamed_total');
          this.metrics.observe(
            'wallet_event_delivery_seconds',
            Math.max(0, Date.now() - entry.createdAt.getTime()) / 1000,
          );
        }
      }
      if (entries.length < this.settings.pageSize) {
        return;
      }
    }
  }

  private send(subscriber: Subscriber, chunk: string): void {
    if (subscriber.closed) {
      return;
    }
    if (!subscriber.sink.write(chunk) && !subscriber.paused) {
      subscriber.paused = true;
      subscriber.sink.onDrain(() => {
        subscriber.paused = false;
        this.wake(subscriber.walletId);
      });
    }
  }

  private assertCapacity(): void {
    if (this.stopped || this.streams >= this.settings.maxStreams) {
      throw new StreamCapacityExceededError();
    }
  }

  private track(subscriber: Subscriber): void {
    let channel = this.channels.get(subscriber.walletId);
    if (channel === undefined) {
      channel = { subscribers: new Set(), running: false, again: false };
      this.channels.set(subscriber.walletId, channel);
    }
    channel.subscribers.add(subscriber);
    this.streams += 1;
    this.metrics.set('wallet_event_streams', this.streams);
  }

  private forget(subscriber: Subscriber): void {
    if (subscriber.closed) {
      return;
    }
    subscriber.closed = true;
    clearTimeout(subscriber.expiry);
    const channel = this.channels.get(subscriber.walletId);
    channel?.subscribers.delete(subscriber);
    if (channel !== undefined && channel.subscribers.size === 0) {
      if (!channel.running) {
        this.channels.delete(subscriber.walletId);
      }
    }
    this.streams -= 1;
    this.metrics.set('wallet_event_streams', this.streams);
  }

  private end(subscriber: Subscriber): void {
    if (subscriber.closed) {
      return;
    }
    this.forget(subscriber);
    subscriber.sink.end();
  }
}
