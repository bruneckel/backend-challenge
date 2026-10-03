import type { ScenarioConfig } from './config';
import type { LatencySummary, TimelineBucket } from './stats';

export interface EnvironmentInfo {
  commit: string;
  branch: string;
  startedAt: string;
  os: string;
  cpu: string;
  cpus: number;
  memoryGb: number;
  bun: string;
  docker: string;
  dockerCpus: number;
  dockerMemoryGb: number;
  postgres: string;
  ministack: string;
}

export interface HttpResult {
  offered: number;
  completed: number;
  outcomes: Record<string, number>;
  latency: LatencySummary;
  throughput: number;
  timeline: TimelineBucket[];
}

export interface SqsResult {
  sent: number;
  sendFailures: number;
  processed: number;
  endToEnd: LatencySummary;
  throughput: number;
}

export interface StepResult {
  concurrency: number;
  completed: number;
  throughput: number;
  errorRate: number;
  latency: LatencySummary;
}

export interface OutageResult {
  startSecond: number;
  endSecond: number;
  failuresDuringOutage: number;
  firstSuccessAfterMs: number | null;
  recoveredAfterMs: number | null;
}

export interface PublishResult {
  operations: number;
  events: number;
  seconds: number;
  throughput: number;
}

export interface Quantiles {
  p50?: number;
  p95?: number;
  p99?: number;
}

export interface ServerResult {
  transactions: { channel: string; status: string; count: number }[];
  replays: number;
  conflicts: number;
  inboxDuplicates: number;
  dbRetries: number;
  lockTimeouts: number;
  versionConflicts: number;
  sqsRetries: number;
  deadLettered: number;
  lockWait: Quantiles;
  processing: Record<string, Quantiles>;
  outboxDelay: Quantiles;
  maxOutboxAgeSeconds: number;
  maxOutboxPending: number;
  maxConnections: number;
  publishedEvents: number;
}

export interface ConsistencyResult {
  wallets: number;
  violations: string[];
  drained: boolean;
  drainSeconds: number;
  dlqDepth: number;
  unpublished: number;
  pendingReferences: number;
  outboxEvents: number;
  eventsDelivered: number;
  eventsQueued: number;
}

export interface StreamResult {
  subscribers: number;
  replicas: number;
  entries: number;
  latency: LatencySummary;
  gaps: number;
  repeats: number;
  behind: number;
  closedEarly: number;
}

export interface ScenarioResult {
  config: ScenarioConfig;
  measuredSeconds: number;
  http?: HttpResult;
  sqs?: SqsResult;
  steps?: StepResult[];
  outage?: OutageResult;
  publish?: PublishResult;
  streams?: StreamResult;
  server: ServerResult;
  consistency: ConsistencyResult;
  generator: { cpuPercent: number };
}
