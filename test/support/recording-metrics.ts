import type {
  CounterName,
  GaugeName,
  HistogramName,
  MetricLabels,
  Metrics,
} from '@shared/application/metrics';

interface Recorded<N> {
  name: N;
  labels: MetricLabels;
  value: number;
}

const matches = (recorded: MetricLabels, expected: MetricLabels) =>
  Object.entries(expected).every(([key, value]) => recorded[key] === value);

export class RecordingMetrics implements Metrics {
  readonly counters: Recorded<CounterName>[] = [];
  readonly observations: Recorded<HistogramName>[] = [];
  readonly gauges: Recorded<GaugeName>[] = [];

  increment(name: CounterName, labels: MetricLabels = {}, value = 1): void {
    this.counters.push({ name, labels, value });
  }

  observe(name: HistogramName, value: number, labels: MetricLabels = {}): void {
    this.observations.push({ name, labels, value });
  }

  set(name: GaugeName, value: number, labels: MetricLabels = {}): void {
    this.gauges.push({ name, labels, value });
  }

  count(name: CounterName, labels: MetricLabels = {}): number {
    return this.counters
      .filter((entry) => entry.name === name && matches(entry.labels, labels))
      .reduce((total, entry) => total + entry.value, 0);
  }

  observed(name: HistogramName, labels: MetricLabels = {}): number[] {
    return this.observations
      .filter((entry) => entry.name === name && matches(entry.labels, labels))
      .map((entry) => entry.value);
  }
}
