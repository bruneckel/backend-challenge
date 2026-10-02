import type { ExponentialBackoff } from '@shared/domain/exponential-backoff';

export interface PollingLoopOptions {
  step: (signal: AbortSignal) => Promise<boolean>;
  idleDelayMs: number;
  errorBackoff: ExponentialBackoff;
  onError?: (error: unknown, consecutiveFailures: number) => void;
}

export class PollingLoop {
  private readonly controller = new AbortController();
  private running: Promise<void> | undefined;

  constructor(private readonly options: PollingLoopOptions) {}

  start(): void {
    this.running ??= this.run();
  }

  async stop(): Promise<void> {
    this.controller.abort();
    await this.running;
  }

  private async run(): Promise<void> {
    const { signal } = this.controller;
    let consecutiveFailures = 0;
    while (!signal.aborted) {
      let delayMs: number;
      try {
        const didWork = await this.options.step(signal);
        consecutiveFailures = 0;
        delayMs = didWork ? 0 : this.options.idleDelayMs;
      } catch (error) {
        consecutiveFailures += 1;
        this.options.onError?.(error, consecutiveFailures);
        delayMs = this.options.errorBackoff.delayFor(consecutiveFailures);
      }
      if (delayMs > 0) {
        await sleep(delayMs, signal);
      }
    }
  }
}

function sleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, delayMs);
    signal.addEventListener('abort', done, { once: true });
  });
}
