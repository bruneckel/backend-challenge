export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

const SERIES = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)/;

function parseLabels(text: string): Record<string, string> {
  const labels: Record<string, string> = {};
  let index = 0;
  while (index < text.length) {
    const equals = text.indexOf('=', index);
    if (equals < 0) {
      break;
    }
    const name = text.slice(index, equals).trim().replace(/^,/, '').trim();
    let cursor = equals + 2;
    let value = '';
    while (cursor < text.length && text[cursor] !== '"') {
      if (text[cursor] === '\\' && cursor + 1 < text.length) {
        const next = text[cursor + 1];
        value += next === 'n' ? '\n' : next;
        cursor += 2;
      } else {
        value += text[cursor];
        cursor += 1;
      }
    }
    labels[name] = value;
    index = cursor + 1;
  }
  return labels;
}

function parseValue(text: string): number {
  if (text === '+Inf') {
    return Infinity;
  }
  if (text === '-Inf') {
    return -Infinity;
  }
  return Number.parseFloat(text);
}

export function parsePrometheus(text: string): Sample[] {
  const samples: Sample[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const match = SERIES.exec(trimmed);
    if (match === null) {
      continue;
    }
    samples.push({
      name: match[1]!,
      labels: match[2] === undefined ? {} : parseLabels(match[2]),
      value: parseValue(match[3]!),
    });
  }
  return samples;
}

const carries = (sample: Sample, labels: Record<string, string>) =>
  Object.entries(labels).every(
    ([name, value]) => sample.labels[name] === value,
  );

const keyOf = (sample: Sample) =>
  `${sample.name}${JSON.stringify(
    Object.entries(sample.labels).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  )}`;

export function sumOf(
  samples: readonly Sample[],
  name: string,
  labels: Record<string, string> = {},
): number {
  return samples
    .filter((sample) => sample.name === name && carries(sample, labels))
    .reduce((total, sample) => total + sample.value, 0);
}

export function subtract(
  after: readonly Sample[],
  before: readonly Sample[],
): Sample[] {
  const previous = new Map(before.map((sample) => [keyOf(sample), sample]));
  return after.map((sample) => ({
    ...sample,
    value: sample.value - (previous.get(keyOf(sample))?.value ?? 0),
  }));
}

export function histogramQuantile(
  samples: readonly Sample[],
  name: string,
  quantile: number,
  labels: Record<string, string> = {},
): number | undefined {
  const cumulative = new Map<number, number>();
  for (const sample of samples) {
    if (sample.name !== `${name}_bucket` || !carries(sample, labels)) {
      continue;
    }
    const bound = parseValue(sample.labels.le ?? '+Inf');
    cumulative.set(bound, (cumulative.get(bound) ?? 0) + sample.value);
  }
  const buckets = [...cumulative.entries()].sort(
    ([left], [right]) => left - right,
  );
  const total = buckets.at(-1)?.[1] ?? 0;
  if (total <= 0) {
    return undefined;
  }
  const target = quantile * total;
  let lowerBound = 0;
  let lowerCount = 0;
  for (const [bound, count] of buckets) {
    if (count >= target) {
      if (bound === Infinity) {
        return lowerBound;
      }
      if (count === lowerCount) {
        return bound;
      }
      return (
        lowerBound +
        ((bound - lowerBound) * (target - lowerCount)) / (count - lowerCount)
      );
    }
    lowerBound = bound;
    lowerCount = count;
  }
  return lowerBound;
}
