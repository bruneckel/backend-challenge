import { parseArgs } from 'node:util';

export type Profile =
  'sustained' | 'spike' | 'saturation' | 'backlog' | 'publish' | 'recovery';
export type Channel = 'http' | 'sqs' | 'mixed';

export interface ScenarioConfig {
  name: string;
  profile: Profile;
  channel: Channel;
  apiInstances: number;
  workerInstances: number;
  wallets: number;
  hotShare: number;
  sqsShare: number;
  replayShare: number;
  rate: number;
  spikeRate: number;
  warmupSeconds: number;
  durationSeconds: number;
  concurrencySteps: number[];
  stepSeconds: number;
  backlogMessages: number;
  outageSeconds: number;
  drainTimeoutSeconds: number;
  requestTimeoutMs: number;
  maxInFlight: number;
  maxErrorRate: number;
  maxP99Ms: number;
  logLevel: string;
  dbPoolSize: number;
}

export interface LoadRun {
  scenarios: ScenarioConfig[];
  output: string;
  keepInfra: boolean;
  keepData: boolean;
}

export const DEFAULT_SCENARIO: ScenarioConfig = {
  name: 'custom',
  profile: 'sustained',
  channel: 'http',
  apiInstances: 1,
  workerInstances: 1,
  wallets: 200,
  hotShare: 0,
  sqsShare: 0.5,
  replayShare: 0,
  rate: 50,
  spikeRate: 150,
  warmupSeconds: 5,
  durationSeconds: 30,
  concurrencySteps: [4, 8, 16, 32, 64],
  stepSeconds: 15,
  backlogMessages: 2000,
  outageSeconds: 10,
  drainTimeoutSeconds: 300,
  requestTimeoutMs: 10_000,
  maxInFlight: 2000,
  maxErrorRate: 0.05,
  maxP99Ms: 5000,
  logLevel: 'info',
  dbPoolSize: 10,
};

type PresetScenario = Partial<ScenarioConfig> & { name: string };

export const PRESETS: Record<string, PresetScenario[]> = {
  smoke: [
    {
      name: 'smoke-http-sustained',
      rate: 20,
      warmupSeconds: 1,
      durationSeconds: 5,
    },
    {
      name: 'smoke-http-saturation',
      profile: 'saturation',
      concurrencySteps: [2, 4],
      stepSeconds: 3,
      warmupSeconds: 1,
    },
    {
      name: 'smoke-sqs-backlog',
      profile: 'backlog',
      channel: 'sqs',
      backlogMessages: 200,
    },
    {
      name: 'smoke-outbox-publish',
      profile: 'publish',
      backlogMessages: 500,
    },
    {
      name: 'smoke-mixed-sustained',
      channel: 'mixed',
      apiInstances: 2,
      workerInstances: 2,
      hotShare: 0.2,
      rate: 30,
      warmupSeconds: 1,
      durationSeconds: 5,
    },
    {
      name: 'smoke-http-spike',
      profile: 'spike',
      rate: 20,
      spikeRate: 60,
      warmupSeconds: 1,
      durationSeconds: 9,
    },
    {
      name: 'smoke-mixed-recovery',
      profile: 'recovery',
      channel: 'mixed',
      rate: 20,
      warmupSeconds: 1,
      durationSeconds: 15,
      outageSeconds: 3,
    },
  ],
  baseline: [
    {
      name: 'http-saturation-1x1',
      profile: 'saturation',
      concurrencySteps: [4, 8, 16, 32, 64, 128],
    },
    {
      name: 'http-saturation-3x3',
      profile: 'saturation',
      apiInstances: 3,
      workerInstances: 3,
      concurrencySteps: [4, 8, 16, 32, 64, 128],
    },
    {
      name: 'http-hot-saturation-3x3',
      profile: 'saturation',
      apiInstances: 3,
      workerInstances: 3,
      hotShare: 1,
      concurrencySteps: [1, 2, 4, 8, 16, 32],
    },
    {
      name: 'sqs-backlog-1x1',
      profile: 'backlog',
      channel: 'sqs',
      backlogMessages: 3000,
    },
    {
      name: 'sqs-backlog-1x3',
      profile: 'backlog',
      channel: 'sqs',
      workerInstances: 3,
      backlogMessages: 3000,
    },
    {
      name: 'sqs-hot-backlog-1x3',
      profile: 'backlog',
      channel: 'sqs',
      workerInstances: 3,
      hotShare: 1,
      backlogMessages: 1000,
    },
    {
      name: 'outbox-publish-1x1',
      profile: 'publish',
      backlogMessages: 20000,
    },
    {
      name: 'outbox-publish-1x3',
      profile: 'publish',
      workerInstances: 3,
      backlogMessages: 20000,
    },
    {
      name: 'mixed-sustained-3x3',
      channel: 'mixed',
      apiInstances: 3,
      workerInstances: 3,
      hotShare: 0.2,
      replayShare: 0.05,
      rate: 150,
      durationSeconds: 60,
    },
    {
      name: 'http-spike-3x3',
      profile: 'spike',
      apiInstances: 3,
      workerInstances: 3,
      rate: 100,
      spikeRate: 300,
      durationSeconds: 45,
    },
    {
      name: 'mixed-recovery-3x3',
      profile: 'recovery',
      channel: 'mixed',
      apiInstances: 3,
      workerInstances: 3,
      rate: 100,
      durationSeconds: 60,
      outageSeconds: 10,
    },
  ],
};

const OPTIONS = {
  preset: { type: 'string' },
  only: { type: 'string' },
  output: { type: 'string' },
  'keep-infra': { type: 'boolean' },
  'keep-data': { type: 'boolean' },
  profile: { type: 'string' },
  channel: { type: 'string' },
  api: { type: 'string' },
  workers: { type: 'string' },
  wallets: { type: 'string' },
  'hot-share': { type: 'string' },
  'sqs-share': { type: 'string' },
  'replay-share': { type: 'string' },
  rate: { type: 'string' },
  'spike-rate': { type: 'string' },
  warmup: { type: 'string' },
  duration: { type: 'string' },
  steps: { type: 'string' },
  'step-seconds': { type: 'string' },
  backlog: { type: 'string' },
  outage: { type: 'string' },
  'drain-timeout': { type: 'string' },
  'timeout-ms': { type: 'string' },
  'max-in-flight': { type: 'string' },
  'max-error-rate': { type: 'string' },
  'max-p99-ms': { type: 'string' },
  'log-level': { type: 'string' },
  pool: { type: 'string' },
} as const;

const NUMERIC_FLAGS: ReadonlyArray<
  [keyof typeof OPTIONS, keyof ScenarioConfig]
> = [
  ['api', 'apiInstances'],
  ['workers', 'workerInstances'],
  ['wallets', 'wallets'],
  ['hot-share', 'hotShare'],
  ['sqs-share', 'sqsShare'],
  ['replay-share', 'replayShare'],
  ['rate', 'rate'],
  ['spike-rate', 'spikeRate'],
  ['warmup', 'warmupSeconds'],
  ['duration', 'durationSeconds'],
  ['step-seconds', 'stepSeconds'],
  ['backlog', 'backlogMessages'],
  ['outage', 'outageSeconds'],
  ['drain-timeout', 'drainTimeoutSeconds'],
  ['timeout-ms', 'requestTimeoutMs'],
  ['max-in-flight', 'maxInFlight'],
  ['max-error-rate', 'maxErrorRate'],
  ['max-p99-ms', 'maxP99Ms'],
  ['pool', 'dbPoolSize'],
];

function overridesFrom(
  values: Record<string, string | boolean | undefined>,
): Partial<ScenarioConfig> {
  const overrides: Record<string, unknown> = {};
  for (const [flag, field] of NUMERIC_FLAGS) {
    const value = values[flag];
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        throw new Error(`--${flag} must be a number`);
      }
      overrides[field] = parsed;
    }
  }
  if (typeof values.profile === 'string') {
    overrides.profile = values.profile;
  }
  if (typeof values.channel === 'string') {
    overrides.channel = values.channel;
  }
  if (typeof values['log-level'] === 'string') {
    overrides.logLevel = values['log-level'];
  }
  if (typeof values.steps === 'string') {
    overrides.concurrencySteps = values.steps.split(',').map(Number);
  }
  return overrides as Partial<ScenarioConfig>;
}

const PROFILES: readonly Profile[] = [
  'sustained',
  'spike',
  'saturation',
  'backlog',
  'publish',
  'recovery',
];
const CHANNELS: readonly Channel[] = ['http', 'sqs', 'mixed'];

export function validateScenario(scenario: ScenarioConfig): ScenarioConfig {
  if (!PROFILES.includes(scenario.profile)) {
    throw new Error(`Unknown profile ${scenario.profile}`);
  }
  if (!CHANNELS.includes(scenario.channel)) {
    throw new Error(`Unknown channel ${scenario.channel}`);
  }
  for (const field of [
    'hotShare',
    'sqsShare',
    'replayShare',
    'maxErrorRate',
  ] as const) {
    if (scenario[field] < 0 || scenario[field] > 1) {
      throw new Error(`${field} must be between 0 and 1`);
    }
  }
  for (const field of [
    'rate',
    'spikeRate',
    'warmupSeconds',
    'outageSeconds',
  ] as const) {
    if (scenario[field] < 0) {
      throw new Error(`${field} must not be negative`);
    }
  }
  for (const field of [
    'apiInstances',
    'workerInstances',
    'wallets',
    'durationSeconds',
    'stepSeconds',
    'backlogMessages',
    'drainTimeoutSeconds',
    'requestTimeoutMs',
    'maxInFlight',
    'maxP99Ms',
    'dbPoolSize',
  ] as const) {
    if (!Number.isInteger(scenario[field]) || scenario[field] < 1) {
      throw new Error(`${field} must be a positive integer`);
    }
  }
  if (
    scenario.concurrencySteps.length === 0 ||
    scenario.concurrencySteps.some(
      (step) => !Number.isInteger(step) || step < 1,
    )
  ) {
    throw new Error('concurrencySteps must be positive integers');
  }
  if (scenario.profile === 'saturation' && scenario.channel !== 'http') {
    throw new Error('saturation needs the http channel');
  }
  if (scenario.profile === 'spike' && scenario.channel === 'sqs') {
    throw new Error('spike needs the http or mixed channel');
  }
  if (scenario.profile === 'backlog' && scenario.channel !== 'sqs') {
    throw new Error('backlog needs the sqs channel');
  }
  if (scenario.profile === 'publish' && scenario.channel !== 'http') {
    throw new Error('publish needs the http channel');
  }
  return scenario;
}

export function parseLoadArgs(argv: readonly string[]): LoadRun {
  const { values } = parseArgs({
    args: [...argv],
    options: OPTIONS,
    strict: true,
  });
  const overrides = overridesFrom(values);
  let scenarios: ScenarioConfig[];
  if (values.preset === undefined) {
    scenarios = [{ ...DEFAULT_SCENARIO, ...overrides }];
  } else {
    const preset = PRESETS[values.preset];
    if (preset === undefined) {
      throw new Error(`Unknown preset ${values.preset}`);
    }
    scenarios = preset.map((scenario) => ({
      ...DEFAULT_SCENARIO,
      ...scenario,
      ...overrides,
    }));
  }
  if (values.only !== undefined) {
    const wanted = values.only.split(',');
    scenarios = scenarios.filter((scenario) => wanted.includes(scenario.name));
    if (scenarios.length === 0) {
      throw new Error(`No scenario matches --only ${values.only}`);
    }
  }
  return {
    scenarios: scenarios.map(validateScenario),
    output: values.output ?? 'load-results',
    keepInfra: values['keep-infra'] === true,
    keepData: values['keep-data'] === true,
  };
}
