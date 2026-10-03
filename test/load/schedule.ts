export interface RatePhase {
  durationSeconds: number;
  ratePerSecond: number;
}

export function arrivalOffsets(phases: readonly RatePhase[]): number[] {
  const offsets: number[] = [];
  let phaseStart = 0;
  for (const phase of phases) {
    const arrivals = Math.round(phase.ratePerSecond * phase.durationSeconds);
    const gap = phase.ratePerSecond > 0 ? 1000 / phase.ratePerSecond : 0;
    for (let index = 0; index < arrivals; index += 1) {
      offsets.push(Math.round(phaseStart + index * gap));
    }
    phaseStart += phase.durationSeconds * 1000;
  }
  return offsets;
}

export interface OpenLoopOptions {
  maxInFlight: number;
  fire: (index: number, intendedAtMs: number) => Promise<void>;
  onDropped: (index: number, intendedAtMs: number) => void;
}

export async function runOpenLoop(
  offsets: readonly number[],
  options: OpenLoopOptions,
): Promise<void> {
  const start = performance.now();
  const pending = new Set<Promise<void>>();
  let next = 0;
  while (next < offsets.length) {
    const elapsed = performance.now() - start;
    const due = offsets[next]!;
    if (due > elapsed) {
      await Bun.sleep(Math.min(due - elapsed, 50));
      continue;
    }
    const intendedAt = start + due;
    if (pending.size >= options.maxInFlight) {
      options.onDropped(next, intendedAt);
    } else {
      const request = options.fire(next, intendedAt).catch(() => undefined);
      pending.add(request);
      void request.finally(() => pending.delete(request));
    }
    next += 1;
  }
  await Promise.all(pending);
}

export async function runClosedLoop(
  concurrency: number,
  durationMs: number,
  task: (worker: number) => Promise<void>,
): Promise<void> {
  const deadline = performance.now() + durationMs;
  await Promise.all(
    Array.from({ length: concurrency }, async (_, worker) => {
      while (performance.now() < deadline) {
        await task(worker).catch(() => undefined);
      }
    }),
  );
}
