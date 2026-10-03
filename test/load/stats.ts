export interface LatencySummary {
  count: number;
  mean: number;
  min: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
}

export interface TimelineBucket {
  second: number;
  completed: number;
  ok: number;
  failed: number;
  p50: number;
  p99: number;
}

export function percentile(
  sorted: ArrayLike<number>,
  fraction: number,
): number {
  if (sorted.length === 0) {
    return NaN;
  }
  const rank = Math.min(
    sorted.length,
    Math.max(1, Math.ceil(fraction * sorted.length)),
  );
  return sorted[rank - 1]!;
}

export function summarize(values: readonly number[]): LatencySummary {
  const sorted = Float64Array.from(values).sort();
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    mean: sorted.length === 0 ? NaN : total / sorted.length,
    min: sorted.length === 0 ? NaN : sorted[0]!,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.length === 0 ? NaN : sorted[sorted.length - 1]!,
  };
}

interface Second {
  latencies: number[];
  ok: number;
  failed: number;
}

export class Timeline {
  private readonly seconds: Second[] = [];

  constructor(private readonly startMs: number) {}

  record(atMs: number, latencyMs: number, ok: boolean): void {
    const index = Math.max(0, Math.floor((atMs - this.startMs) / 1000));
    while (this.seconds.length <= index) {
      this.seconds.push({ latencies: [], ok: 0, failed: 0 });
    }
    const second = this.seconds[index]!;
    second.latencies.push(latencyMs);
    if (ok) {
      second.ok += 1;
    } else {
      second.failed += 1;
    }
  }

  buckets(): TimelineBucket[] {
    return this.seconds.map((second, index) => {
      const sorted = Float64Array.from(second.latencies).sort();
      return {
        second: index,
        completed: second.latencies.length,
        ok: second.ok,
        failed: second.failed,
        p50: percentile(sorted, 0.5),
        p99: percentile(sorted, 0.99),
      };
    });
  }
}
