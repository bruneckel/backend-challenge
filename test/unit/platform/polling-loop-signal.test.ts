import { describe, expect, test } from 'bun:test';
import { PollingLoop } from '@platform/lifecycle/polling-loop';
import { ExponentialBackoff } from '@shared/domain/exponential-backoff';
import { waitUntil } from '@test/support/async';

describe('PollingLoop stop signal', () => {
  test('hands each step a signal that aborts when the loop stops', async () => {
    let seen: AbortSignal | undefined;
    const loop = new PollingLoop({
      step: async (signal) => {
        seen = signal;
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return false;
      },
      idleDelayMs: 10,
      errorBackoff: ExponentialBackoff.create({ baseMs: 5, maxMs: 5 }),
    });

    loop.start();
    await waitUntil(() => seen !== undefined);
    await loop.stop();

    expect(seen?.aborted).toBe(true);
  });
});
