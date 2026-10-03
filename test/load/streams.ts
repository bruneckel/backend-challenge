import { OPERATOR, bearerFor } from '@test/support/identity';
import {
  type EventStream,
  type StreamedEvent,
  openEventStream,
} from '@test/support/sse';
import type { AppProcess, Storage } from './cluster';
import { summarize } from './stats';
import type { StreamResult } from './types';

export class StreamTracker {
  lastVersion = 0;
  entries = 0;
  gaps = 0;
  repeats = 0;
  readonly latenciesMs: number[] = [];

  constructor(readonly walletId: string) {}

  receive(event: StreamedEvent, receivedAt: number): void {
    if (event.event === 'wallet') {
      this.lastVersion = Number(event.data.version);
      return;
    }
    const version = Number(event.data.walletVersion);
    this.entries += 1;
    if (version <= this.lastVersion) {
      this.repeats += 1;
      return;
    }
    this.gaps += version - this.lastVersion - 1;
    this.lastVersion = version;
    this.latenciesMs.push(receivedAt - Date.parse(event.data.createdAt));
  }

  behind(storedVersion: number): number {
    return Math.max(0, storedVersion - this.lastVersion);
  }
}

export class StreamWatch {
  private constructor(
    private readonly streams: EventStream[],
    private readonly trackers: StreamTracker[],
    private readonly replicas: number,
  ) {}

  static async open(
    apis: readonly AppProcess[],
    walletIds: readonly string[],
  ): Promise<StreamWatch> {
    const authorization = await bearerFor({ roles: [OPERATOR] });
    const trackers = walletIds.map((walletId) => new StreamTracker(walletId));
    const streams = await Promise.all(
      trackers.map((tracker, index) =>
        openEventStream(
          `${apis[index % apis.length]!.url}/wallets/${tracker.walletId}/events`,
          { authorization },
          {
            onEvent: (event, receivedAt) => tracker.receive(event, receivedAt),
          },
        ),
      ),
    );
    const refused = streams.filter((stream) => stream.status !== 200);
    if (refused.length > 0) {
      throw new Error(
        `${refused.length} subscriptions refused (status ${refused[0]!.status})`,
      );
    }
    return new StreamWatch(
      streams,
      trackers,
      Math.min(apis.length, walletIds.length),
    );
  }

  async settle(storage: Storage, timeoutMs: number): Promise<StreamResult> {
    const deadline = performance.now() + timeoutMs;
    let behind = await this.behind(storage);
    while (behind > 0 && performance.now() < deadline) {
      await Bun.sleep(100);
      behind = await this.behind(storage);
    }
    const closed = this.streams.filter((stream) => stream.closed).length;
    for (const stream of this.streams) {
      stream.close();
    }
    return {
      subscribers: this.trackers.length,
      replicas: this.replicas,
      entries: this.trackers.reduce((total, item) => total + item.entries, 0),
      latency: summarize(this.trackers.flatMap((item) => item.latenciesMs)),
      gaps: this.trackers.reduce((total, item) => total + item.gaps, 0),
      repeats: this.trackers.reduce((total, item) => total + item.repeats, 0),
      behind,
      closedEarly: closed,
    };
  }

  close(): void {
    for (const stream of this.streams) {
      stream.close();
    }
  }

  private async behind(storage: Storage): Promise<number> {
    const rows: { id: string; version: number }[] =
      await storage.sql`select id, version from wallets where id in ${storage.sql(
        this.trackers.map((tracker) => tracker.walletId),
      )}`;
    const versions = new Map(rows.map((row) => [row.id, row.version]));
    return this.trackers.reduce(
      (total, tracker) =>
        total + tracker.behind(versions.get(tracker.walletId) ?? 0),
      0,
    );
  }
}
