import { describe, expect, test } from 'bun:test';
import { PRESETS, parseLoadArgs } from '@test/load/config';

describe('parseLoadArgs', () => {
  test('builds a single custom scenario from the defaults and the flags', () => {
    const run = parseLoadArgs([
      '--profile',
      'sustained',
      '--channel',
      'mixed',
      '--api',
      '3',
      '--workers',
      '3',
      '--rate',
      '120',
      '--hot-share',
      '0.2',
      '--steps',
      '4,8,16',
    ]);

    expect(run.scenarios).toHaveLength(1);
    expect(run.scenarios[0]).toMatchObject({
      name: 'custom',
      profile: 'sustained',
      channel: 'mixed',
      apiInstances: 3,
      workerInstances: 3,
      rate: 120,
      hotShare: 0.2,
      concurrencySteps: [4, 8, 16],
    });
    expect(run.keepInfra).toBe(false);
  });

  test('expands a preset and applies the flags to every scenario of it', () => {
    const run = parseLoadArgs(['--preset', 'baseline', '--duration', '7']);

    expect(run.scenarios.map((scenario) => scenario.name)).toEqual(
      PRESETS.baseline!.map((scenario) => scenario.name),
    );
    expect(
      run.scenarios.every((scenario) => scenario.durationSeconds === 7),
    ).toBe(true);
  });

  test('keeps only the scenarios named by --only', () => {
    const [first, second] = PRESETS.baseline!;
    const run = parseLoadArgs([
      '--preset',
      'baseline',
      '--only',
      `${first!.name},${second!.name}`,
    ]);

    expect(run.scenarios.map((scenario) => scenario.name)).toEqual([
      first!.name,
      second!.name,
    ]);
  });

  test.each([
    [['--preset', 'unknown'], 'Unknown preset unknown'],
    [['--hot-share', '1.5'], 'hotShare must be between 0 and 1'],
    [['--rate=-1'], 'rate must not be negative'],
    [
      ['--profile', 'saturation', '--channel', 'sqs'],
      'saturation needs the http channel',
    ],
    [
      ['--profile', 'backlog', '--channel', 'http'],
      'backlog needs the sqs channel',
    ],
    [
      ['--profile', 'publish', '--channel', 'sqs'],
      'publish needs the http channel',
    ],
    [
      ['--drain-timeout', '0'],
      'drainTimeoutSeconds must be a positive integer',
    ],
    [['--only', 'nothing'], 'No scenario matches --only nothing'],
    [
      ['--wallets', '10', '--subscribers', '12'],
      'subscribers must be between 0 and wallets + 1',
    ],
    [
      ['--profile', 'backlog', '--channel', 'sqs', '--subscribers', '1'],
      'backlog does not open streams',
    ],
    [
      ['--seed-wallets', '100', '--wallets', '200'],
      'wallets must not exceed seedWallets',
    ],
    [['--seed-operations=-1'], 'seedOperations must be a non-negative integer'],
    [['--app-env', 'retention'], '--app-env takes NAME=VALUE'],
  ])('refuses %j', (argv, message) => {
    expect(() => parseLoadArgs(argv)).toThrow(message);
  });

  test('reads the seed flags', () => {
    const [scenario] = parseLoadArgs([
      '--seed-wallets',
      '1000',
      '--seed-operations',
      '6',
      '--seed-hot-entries',
      '50',
      '--seed-events',
    ]).scenarios;

    expect(scenario).toMatchObject({
      seedWallets: 1000,
      seedOperations: 6,
      seedHotEntries: 50,
      seedEvents: true,
    });
  });

  test('passes environment variables to the application processes', () => {
    const [scenario] = parseLoadArgs([
      '--app-env',
      'RETENTION_ENABLED=false',
      '--app-env',
      'DB_POOL_SIZE=20',
    ]).scenarios;

    expect(scenario?.appEnv).toEqual({
      RETENTION_ENABLED: 'false',
      DB_POOL_SIZE: '20',
    });
  });

  test('adds environment variables to the ones a preset sets', () => {
    const scenarios = parseLoadArgs([
      '--preset',
      'retention',
      '--app-env',
      'RETENTION_BATCH_SIZE=500',
    ]).scenarios;

    expect(scenarios.map((scenario) => scenario.appEnv)).toEqual([
      { RETENTION_BATCH_SIZE: '500' },
      { RETENTION_ENABLED: 'false', RETENTION_BATCH_SIZE: '500' },
    ]);
  });

  test('every preset scenario is valid on its own', () => {
    for (const name of Object.keys(PRESETS)) {
      expect(parseLoadArgs(['--preset', name]).scenarios.length).toBe(
        PRESETS[name]!.length,
      );
    }
  });
});
