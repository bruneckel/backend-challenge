import { testIdentity } from '@test/support/identity';
import {
  type LoadWallet,
  openWalletOverHttp,
  runConcurrently,
} from '@test/support/load';
import {
  type AppProcess,
  type Storage,
  createStorage,
  startApp,
} from './cluster';
import {
  EventSink,
  Sampler,
  consistencyOf,
  outboxEvents,
  processedAt,
  publishSpanSeconds,
  scrape,
  serverResult,
  unpublishedEvents,
  waitForDrain,
} from './collectors';
import type { ScenarioConfig } from './config';
import { pauseDatabase, resumeDatabase } from './infra';
import type { Sample } from './prometheus';
import {
  type RatePhase,
  arrivalOffsets,
  runClosedLoop,
  runOpenLoop,
} from './schedule';
import { Timeline, summarize } from './stats';
import {
  OperationFactory,
  type Outcome,
  type QueuedOperation,
  SUCCESSFUL,
  enqueueBatch,
  submit,
} from './traffic';
import type {
  HttpResult,
  OutageResult,
  PublishResult,
  ScenarioResult,
  SqsResult,
  StepResult,
} from './types';

const INITIAL_BALANCE = '1000000.00';
const MAX_PENDING_BATCHES = 64;

const log = (message: string) =>
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);

class HttpRecorder {
  readonly outcomes: Record<string, number> = {};
  readonly latencies: number[] = [];
  readonly successTimes: number[] = [];
  readonly timeline: Timeline;
  completed = 0;

  constructor(readonly startMs: number) {
    this.timeline = new Timeline(startMs);
  }

  record(outcome: Outcome, atMs: number, latencyMs: number): void {
    this.completed += 1;
    this.outcomes[outcome] = (this.outcomes[outcome] ?? 0) + 1;
    const ok = SUCCESSFUL.has(outcome);
    if (ok) {
      this.latencies.push(latencyMs);
      this.successTimes.push(atMs);
    }
    this.timeline.record(atMs, latencyMs, ok);
  }

  drop(): void {
    this.outcomes.dropped = (this.outcomes.dropped ?? 0) + 1;
  }

  get successes(): number {
    return this.latencies.length;
  }

  result(offered: number, seconds: number): HttpResult {
    return {
      offered,
      completed: this.completed,
      outcomes: { ...this.outcomes },
      latency: summarize(this.latencies),
      throughput: this.successes / seconds,
      timeline: this.timeline.buckets(),
    };
  }
}

class SqsRecorder {
  readonly sentAt = new Map<string, number>();
  sent = 0;
  failed = 0;
}

interface Context {
  readonly config: ScenarioConfig;
  readonly storage: Storage;
  readonly apis: AppProcess[];
  readonly workers: AppProcess[];
  readonly factory: OperationFactory;
}

interface LevelPhase {
  durationSeconds: number;
  rate: number;
}

function split(config: ScenarioConfig, rate: number) {
  if (config.channel === 'http') {
    return { http: rate, sqs: 0 };
  }
  if (config.channel === 'sqs') {
    return { http: 0, sqs: rate };
  }
  return { http: rate * (1 - config.sqsShare), sqs: rate * config.sqsShare };
}

function levelsOf(config: ScenarioConfig): LevelPhase[] {
  if (config.profile === 'spike') {
    const third = config.durationSeconds / 3;
    return [
      { durationSeconds: third, rate: config.rate },
      { durationSeconds: third, rate: config.spikeRate },
      { durationSeconds: third, rate: config.rate },
    ];
  }
  return [{ durationSeconds: config.durationSeconds, rate: config.rate }];
}

async function driveHttp(
  context: Context,
  phases: RatePhase[],
  recorder: HttpRecorder | undefined,
): Promise<number> {
  const { apis, factory, config } = context;
  const offsets = arrivalOffsets(phases);
  await runOpenLoop(offsets, {
    maxInFlight: config.maxInFlight,
    fire: async (index, intendedAt) => {
      const outcome = await submit(
        apis[index % apis.length]!.url,
        factory.next(),
        config.requestTimeoutMs,
      );
      const now = performance.now();
      recorder?.record(outcome, now, now - intendedAt);
    },
    onDropped: () => recorder?.drop(),
  });
  return offsets.length;
}

async function sendItems(
  storage: Storage,
  items: QueuedOperation[],
  recorder: SqsRecorder | undefined,
): Promise<void> {
  const at = Date.now();
  const { sent, failed } = await enqueueBatch(
    storage.sqs,
    storage.queues.commands,
    items,
  );
  if (recorder !== undefined) {
    recorder.sent += sent;
    recorder.failed += failed;
    for (const item of items) {
      recorder.sentAt.set(item.messageId, at);
    }
  }
}

const queued = (context: Context): QueuedOperation => ({
  operation: context.factory.next(),
  messageId: `msg-${Bun.randomUUIDv7()}`,
});

async function driveSqs(
  context: Context,
  phases: RatePhase[],
  recorder: SqsRecorder | undefined,
): Promise<void> {
  const offsets = arrivalOffsets(phases);
  const start = performance.now();
  const pending = new Set<Promise<void>>();
  let next = 0;
  while (next < offsets.length) {
    const elapsed = performance.now() - start;
    if (offsets[next]! > elapsed) {
      await Bun.sleep(Math.min(offsets[next]! - elapsed, 20));
      continue;
    }
    const items: QueuedOperation[] = [];
    while (
      next < offsets.length &&
      offsets[next]! <= elapsed &&
      items.length < 10
    ) {
      items.push(queued(context));
      next += 1;
    }
    if (pending.size >= MAX_PENDING_BATCHES) {
      await Promise.race(pending);
    }
    const batch = sendItems(context.storage, items, recorder);
    pending.add(batch);
    void batch.finally(() => pending.delete(batch));
  }
  await Promise.all(pending);
}

async function driveOpen(
  context: Context,
  levels: LevelPhase[],
  http: HttpRecorder | undefined,
  sqs: SqsRecorder | undefined,
): Promise<number> {
  const httpPhases = levels.map((level) => ({
    durationSeconds: level.durationSeconds,
    ratePerSecond: split(context.config, level.rate).http,
  }));
  const sqsPhases = levels.map((level) => ({
    durationSeconds: level.durationSeconds,
    ratePerSecond: split(context.config, level.rate).sqs,
  }));
  const [offered] = await Promise.all([
    httpPhases.some((phase) => phase.ratePerSecond > 0)
      ? driveHttp(context, httpPhases, http)
      : Promise.resolve(0),
    sqsPhases.some((phase) => phase.ratePerSecond > 0)
      ? driveSqs(context, sqsPhases, sqs)
      : Promise.resolve(),
  ]);
  return offered;
}

async function saturate(
  context: Context,
): Promise<{ steps: StepResult[]; seconds: number }> {
  const { apis, factory, config } = context;
  const steps: StepResult[] = [];
  let seconds = 0;
  let turn = 0;
  for (const concurrency of config.concurrencySteps) {
    const recorder = new HttpRecorder(performance.now());
    await runClosedLoop(concurrency, config.stepSeconds * 1000, async () => {
      const api = apis[turn++ % apis.length]!;
      const started = performance.now();
      const outcome = await submit(
        api.url,
        factory.next(),
        config.requestTimeoutMs,
      );
      const now = performance.now();
      recorder.record(outcome, now, now - started);
    });
    seconds += config.stepSeconds;
    const errors = recorder.completed - recorder.successes;
    const step: StepResult = {
      concurrency,
      completed: recorder.completed,
      throughput: recorder.successes / config.stepSeconds,
      errorRate: recorder.completed === 0 ? 0 : errors / recorder.completed,
      latency: summarize(recorder.latencies),
    };
    steps.push(step);
    log(
      `  c=${concurrency} ${step.throughput.toFixed(1)}/s p99 ${step.latency.p99.toFixed(1)} ms errors ${(step.errorRate * 100).toFixed(1)}%`,
    );
    if (
      step.errorRate > config.maxErrorRate ||
      step.latency.p99 > config.maxP99Ms
    ) {
      break;
    }
  }
  return { steps, seconds };
}

async function sqsResult(
  storage: Storage,
  recorder: SqsRecorder,
  seconds: number,
  backlog: boolean,
): Promise<SqsResult> {
  const processed = await processedAt(storage);
  const latencies: number[] = [];
  const completions: number[] = [];
  for (const [messageId, sentAt] of recorder.sentAt) {
    const at = processed.get(messageId);
    if (at !== undefined) {
      latencies.push(at - sentAt);
      completions.push(at);
    }
  }
  const span =
    completions.length > 1
      ? (Math.max(...completions) - Math.min(...completions)) / 1000
      : seconds;
  return {
    sent: recorder.sent,
    sendFailures: recorder.failed,
    processed: latencies.length,
    endToEnd: summarize(latencies),
    throughput: latencies.length / (backlog ? span : seconds),
  };
}

function outageOf(
  recorder: HttpRecorder,
  pausedAt: number,
  resumedAt: number,
  expectedPerSecond: number,
): OutageResult {
  const startSecond = Math.floor((pausedAt - recorder.startMs) / 1000);
  const endSecond = Math.floor((resumedAt - recorder.startMs) / 1000);
  const buckets = recorder.timeline.buckets();
  const failuresDuringOutage = buckets
    .slice(startSecond, endSecond + 1)
    .reduce((total, bucket) => total + bucket.failed, 0);
  const firstSuccess = recorder.successTimes.find((at) => at >= resumedAt);
  const recovered = buckets.find(
    (bucket) =>
      bucket.second > endSecond && bucket.ok >= 0.9 * expectedPerSecond,
  );
  return {
    startSecond,
    endSecond,
    failuresDuringOutage,
    firstSuccessAfterMs:
      firstSuccess === undefined ? null : firstSuccess - resumedAt,
    recoveredAfterMs:
      recovered === undefined
        ? null
        : recorder.startMs + (recovered.second + 1) * 1000 - resumedAt,
  };
}

async function seedWallets(
  api: AppProcess,
  count: number,
): Promise<LoadWallet[]> {
  const wallets: LoadWallet[] = [];
  await runConcurrently(
    Array.from({ length: count }, (_, index) => index),
    16,
    async () => {
      wallets.push(await openWalletOverHttp(api.url, INITIAL_BALANCE));
    },
  );
  return wallets;
}

const range = (count: number) =>
  Array.from({ length: count }, (_, index) => index + 1);

export async function runScenario(
  config: ScenarioConfig,
  id: string,
  logDir: string,
  keepData: boolean,
): Promise<ScenarioResult> {
  const storage = await createStorage(id);
  const sink = new EventSink(storage);
  sink.start();
  const drainTimeoutMs = config.drainTimeoutSeconds * 1000;
  const environment = {
    ...storage.environment,
    ...(await testIdentity()).environment,
    LOG_LEVEL: config.logLevel,
    DB_POOL_SIZE: String(config.dbPoolSize),
    METRICS_SAMPLE_INTERVAL_MS: '1000',
  };
  const processes: AppProcess[] = [];
  try {
    const apis = await Promise.all(
      range(config.apiInstances).map((index) =>
        startApp('api', index, environment, logDir),
      ),
    );
    processes.push(...apis);
    const [hot, ...wallets] = await seedWallets(apis[0]!, config.wallets + 1);
    const context: Context = {
      config,
      storage,
      apis,
      workers: [],
      factory: new OperationFactory({
        wallets,
        hot: hot!,
        hotShare: config.hotShare,
        replayShare: config.replayShare,
      }),
    };
    const startWorkers = async () => {
      const workers = await Promise.all(
        range(config.workerInstances).map((index) =>
          startApp('worker', index, environment, logDir),
        ),
      );
      context.workers.push(...workers);
      processes.push(...workers);
    };
    log(`  ${config.wallets + 1} wallets opened`);

    const sampler = new Sampler(() => context.workers, storage);
    let before: Sample[] = [];
    let measuredSeconds = 0;
    let http: HttpResult | undefined;
    let sqs: SqsResult | undefined;
    let steps: StepResult[] | undefined;
    let outage: OutageResult | undefined;
    let publish: PublishResult | undefined;
    let drain: { drained: boolean; seconds: number };
    const cpuAtStart = process.cpuUsage();
    const wallAtStart = performance.now();

    if (config.profile === 'backlog') {
      const recorder = new SqsRecorder();
      const batches: QueuedOperation[][] = [];
      for (let sent = 0; sent < config.backlogMessages; sent += 10) {
        batches.push(
          Array.from(
            { length: Math.min(10, config.backlogMessages - sent) },
            () => queued(context),
          ),
        );
      }
      await runConcurrently(batches, 16, (batch) =>
        sendItems(storage, batch, recorder),
      );
      log(`  ${recorder.sent} messages queued`);
      before = await scrape(apis);
      sampler.start();
      const started = performance.now();
      await startWorkers();
      drain = await waitForDrain(storage, drainTimeoutMs);
      measuredSeconds = (performance.now() - started) / 1000;
      sqs = await sqsResult(storage, recorder, measuredSeconds, true);
    } else if (config.profile === 'publish') {
      let turn = 0;
      await runConcurrently(
        Array.from({ length: config.backlogMessages }, (_, index) => index),
        32,
        async () => {
          await submit(
            apis[turn++ % apis.length]!.url,
            context.factory.next(),
            config.requestTimeoutMs,
          );
        },
      );
      const events = await unpublishedEvents(storage);
      log(`  ${config.backlogMessages} operations left ${events} events`);
      before = await scrape(apis);
      sampler.start();
      const started = performance.now();
      await startWorkers();
      drain = await waitForDrain(storage, drainTimeoutMs);
      measuredSeconds = (performance.now() - started) / 1000;
      const seconds = await publishSpanSeconds(storage);
      publish = {
        operations: config.backlogMessages,
        events,
        seconds,
        throughput: events / seconds,
      };
    } else {
      await startWorkers();
      if (config.warmupSeconds > 0) {
        if (config.profile === 'saturation') {
          await runClosedLoop(
            config.concurrencySteps[0]!,
            config.warmupSeconds * 1000,
            async () => {
              await submit(
                apis[0]!.url,
                context.factory.next(),
                config.requestTimeoutMs,
              );
            },
          );
        } else {
          await driveOpen(
            context,
            [{ durationSeconds: config.warmupSeconds, rate: config.rate }],
            undefined,
            undefined,
          );
        }
        await waitForDrain(storage, drainTimeoutMs);
        log('  warm-up done');
      }
      before = await scrape([...apis, ...context.workers]);
      sampler.start();
      if (config.profile === 'saturation') {
        const saturation = await saturate(context);
        steps = saturation.steps;
        measuredSeconds = saturation.seconds;
        drain = await waitForDrain(storage, drainTimeoutMs);
      } else {
        const httpRecorder = new HttpRecorder(performance.now());
        const sqsRecorder = new SqsRecorder();
        const levels = levelsOf(config);
        let pausedAt = 0;
        let resumedAt = 0;
        const outageRun =
          config.profile === 'recovery'
            ? (async () => {
                await Bun.sleep((config.durationSeconds * 1000) / 3);
                pausedAt = performance.now();
                await pauseDatabase();
                log('  PostgreSQL paused');
                try {
                  await Bun.sleep(config.outageSeconds * 1000);
                } finally {
                  await resumeDatabase();
                  resumedAt = performance.now();
                  log('  PostgreSQL resumed');
                }
              })()
            : Promise.resolve();
        const [offered] = await Promise.all([
          driveOpen(context, levels, httpRecorder, sqsRecorder),
          outageRun,
        ]);
        measuredSeconds = levels.reduce(
          (total, level) => total + level.durationSeconds,
          0,
        );
        if (offered > 0) {
          http = httpRecorder.result(offered, measuredSeconds);
        }
        if (config.profile === 'recovery' && offered > 0) {
          outage = outageOf(
            httpRecorder,
            pausedAt,
            resumedAt,
            split(config, config.rate).http,
          );
        }
        drain = await waitForDrain(storage, drainTimeoutMs);
        if (sqsRecorder.sentAt.size > 0) {
          sqs = await sqsResult(storage, sqsRecorder, measuredSeconds, false);
        }
      }
    }

    const cpu = process.cpuUsage(cpuAtStart);
    const wallMs = performance.now() - wallAtStart;
    sampler.stop();
    const after = await scrape([...apis, ...context.workers]);
    await sink.catchUp(await outboxEvents(storage), drainTimeoutMs);
    await sink.stop();
    return {
      config,
      measuredSeconds,
      http,
      sqs,
      steps,
      outage,
      publish,
      server: serverResult(before, after, sampler),
      consistency: await consistencyOf(storage, drain, sink),
      generator: {
        cpuPercent: ((cpu.user + cpu.system) / 1000 / wallMs) * 100,
      },
    };
  } finally {
    await Promise.allSettled(processes.map((app) => app.stop()));
    await sink.stop();
    await storage.dispose(keepData);
  }
}
