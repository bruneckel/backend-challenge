import { describe, expect, test } from 'bun:test';
import {
  InvalidConfigurationError,
  loadConfig,
} from '@platform/config/app-config';

describe('loadConfig', () => {
  test('uses local development defaults when nothing is set', () => {
    expect(loadConfig({})).toEqual({
      databaseUrl: 'postgresql://wagering:wagering@localhost:5432/wagering',
      port: 3000,
      instanceId: expect.any(String),
      database: {
        poolSize: 10,
        lockTimeoutMs: 3000,
        statementTimeoutMs: 10000,
        idleInTransactionTimeoutMs: 30000,
      },
      reference: {
        maxAttempts: 10,
        backoffBaseMs: 2000,
        backoffMaxMs: 120000,
        schedulerBatchSize: 20,
        schedulerPollIntervalMs: 1000,
        maxProcessingFailures: 3,
      },
      sqs: {
        endpoint: 'http://localhost:4566',
        region: 'us-east-1',
        accessKeyId: 'test',
        secretAccessKey: 'test',
        commandsQueue: 'wager-transactions.fifo',
        deadLetterQueue: 'wager-transactions-dlq.fifo',
        eventsQueue: 'wagering-events.fifo',
        publishTimeoutMs: 5000,
      },
      outbox: {
        batchSize: 10,
        pollIntervalMs: 500,
        retryBaseMs: 1000,
        retryMaxMs: 300000,
      },
      consumer: {
        name: 'wager-transactions-consumer',
        batchSize: 10,
        waitTimeSeconds: 20,
        receiveTimeoutMs: 25000,
        visibilityTimeoutSeconds: 30,
        heartbeatIntervalMs: 10000,
        maxAttempts: 8,
        retryBaseMs: 2000,
        retryMaxMs: 120000,
        maxConcurrentGroups: 5,
      },
      worker: {
        publisherEnabled: true,
        consumerEnabled: true,
        schedulerEnabled: true,
      },
      observability: {
        logLevel: 'info',
        metricsSampleIntervalMs: 5000,
        readinessCacheMs: 2000,
      },
      auth: {
        issuer: 'http://localhost:8080/realms/wagering',
        audience: 'wagering-api',
        jwksUrl:
          'http://localhost:8080/realms/wagering/protocol/openid-connect/certs',
        jwksTimeoutMs: 5000,
        clockSkewSeconds: 5,
      },
      streams: {
        maxStreams: 1000,
        sweepIntervalMs: 500,
        heartbeatIntervalMs: 15000,
      },
    });
  });

  test('reads every setting from the environment', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://user:secret@db:5432/wagering',
      PORT: '0',
      INSTANCE_ID: 'api-2',
      DB_POOL_SIZE: '20',
      DB_LOCK_TIMEOUT_MS: '500',
      DB_STATEMENT_TIMEOUT_MS: '2000',
      DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '4000',
      REFERENCE_MAX_ATTEMPTS: '3',
      REFERENCE_BACKOFF_BASE_MS: '100',
      REFERENCE_BACKOFF_MAX_MS: '400',
      AWS_ENDPOINT_URL: 'http://sqs:4566',
      AWS_REGION: 'sa-east-1',
      AWS_ACCESS_KEY_ID: 'key',
      AWS_SECRET_ACCESS_KEY: 'secret',
      SQS_COMMANDS_QUEUE: 'commands.fifo',
      SQS_DEAD_LETTER_QUEUE: 'commands-dlq.fifo',
      SQS_EVENTS_QUEUE: 'events.fifo',
      SQS_PUBLISH_TIMEOUT_MS: '1500',
      OUTBOX_BATCH_SIZE: '5',
      OUTBOX_POLL_INTERVAL_MS: '50',
      OUTBOX_RETRY_BASE_MS: '10',
      OUTBOX_RETRY_MAX_MS: '100',
      OUTBOX_PUBLISHER_ENABLED: 'false',
      CONSUMER_ENABLED: 'false',
      CONSUMER_NAME: 'consumer-b',
      CONSUMER_BATCH_SIZE: '4',
      SQS_RECEIVE_WAIT_SECONDS: '1',
      SQS_RECEIVE_TIMEOUT_MS: '3000',
      SQS_VISIBILITY_TIMEOUT_SECONDS: '5',
      SQS_HEARTBEAT_INTERVAL_MS: '1000',
      CONSUMER_MAX_ATTEMPTS: '3',
      CONSUMER_RETRY_BASE_MS: '1000',
      CONSUMER_RETRY_MAX_MS: '4000',
      CONSUMER_MAX_CONCURRENT_GROUPS: '2',
      REFERENCE_SCHEDULER_ENABLED: 'false',
      REFERENCE_SCHEDULER_BATCH_SIZE: '7',
      REFERENCE_SCHEDULER_POLL_INTERVAL_MS: '25',
      REFERENCE_MAX_PROCESSING_FAILURES: '2',
      LOG_LEVEL: 'warn',
      METRICS_SAMPLE_INTERVAL_MS: '250',
      READINESS_CACHE_MS: '0',
      AUTH_ISSUER: 'http://localhost:8080/realms/wagering',
      AUTH_AUDIENCE: 'wallet',
      AUTH_JWKS_URL: 'http://keycloak:8080/realms/wagering/certs',
      AUTH_JWKS_TIMEOUT_MS: '2500',
      AUTH_CLOCK_SKEW_SECONDS: '0',
      STREAM_MAX_STREAMS: '50',
      STREAM_SWEEP_INTERVAL_MS: '250',
      STREAM_HEARTBEAT_INTERVAL_MS: '5000',
    });

    expect(config).toEqual({
      databaseUrl: 'postgres://user:secret@db:5432/wagering',
      port: 0,
      instanceId: 'api-2',
      database: {
        poolSize: 20,
        lockTimeoutMs: 500,
        statementTimeoutMs: 2000,
        idleInTransactionTimeoutMs: 4000,
      },
      reference: {
        maxAttempts: 3,
        backoffBaseMs: 100,
        backoffMaxMs: 400,
        schedulerBatchSize: 7,
        schedulerPollIntervalMs: 25,
        maxProcessingFailures: 2,
      },
      sqs: {
        endpoint: 'http://sqs:4566',
        region: 'sa-east-1',
        accessKeyId: 'key',
        secretAccessKey: 'secret',
        commandsQueue: 'commands.fifo',
        deadLetterQueue: 'commands-dlq.fifo',
        eventsQueue: 'events.fifo',
        publishTimeoutMs: 1500,
      },
      outbox: {
        batchSize: 5,
        pollIntervalMs: 50,
        retryBaseMs: 10,
        retryMaxMs: 100,
      },
      consumer: {
        name: 'consumer-b',
        batchSize: 4,
        waitTimeSeconds: 1,
        receiveTimeoutMs: 3000,
        visibilityTimeoutSeconds: 5,
        heartbeatIntervalMs: 1000,
        maxAttempts: 3,
        retryBaseMs: 1000,
        retryMaxMs: 4000,
        maxConcurrentGroups: 2,
      },
      worker: {
        publisherEnabled: false,
        consumerEnabled: false,
        schedulerEnabled: false,
      },
      observability: {
        logLevel: 'warn',
        metricsSampleIntervalMs: 250,
        readinessCacheMs: 0,
      },
      auth: {
        issuer: 'http://localhost:8080/realms/wagering',
        audience: 'wallet',
        jwksUrl: 'http://keycloak:8080/realms/wagering/certs',
        jwksTimeoutMs: 2500,
        clockSkewSeconds: 0,
      },
      streams: {
        maxStreams: 50,
        sweepIntervalMs: 250,
        heartbeatIntervalMs: 5000,
      },
    });
  });

  test('derives the key set url from the token issuer', () => {
    const { auth } = loadConfig({
      AUTH_ISSUER: 'https://id.example.com/realms/casino/',
    });

    expect(auth.jwksUrl).toBe(
      'https://id.example.com/realms/casino/protocol/openid-connect/certs',
    );
  });

  test.each([
    [
      'a queue name without the .fifo suffix',
      { SQS_EVENTS_QUEUE: 'events' },
      /SQS_EVENTS_QUEUE/,
    ],
    [
      'an outbox batch above the SQS limit of ten',
      { OUTBOX_BATCH_SIZE: '11' },
      /OUTBOX_BATCH_SIZE/,
    ],
    [
      'a switch that is not a boolean',
      { OUTBOX_PUBLISHER_ENABLED: 'yes' },
      /OUTBOX_PUBLISHER_ENABLED/,
    ],
    [
      'a long poll longer than twenty seconds',
      { SQS_RECEIVE_WAIT_SECONDS: '21' },
      /SQS_RECEIVE_WAIT_SECONDS/,
    ],
    [
      'a read timeout that does not outlast the long poll',
      { SQS_RECEIVE_TIMEOUT_MS: '20000' },
      /SQS_RECEIVE_TIMEOUT_MS/,
    ],
    ['an unknown log level', { LOG_LEVEL: 'loud' }, /LOG_LEVEL/],
    [
      'a heartbeat slower than the visibility timeout',
      { SQS_HEARTBEAT_INTERVAL_MS: '30000' },
      /SQS_HEARTBEAT_INTERVAL_MS/,
    ],
    [
      'a token issuer that is not http or https',
      { AUTH_ISSUER: 'ftp://localhost/realms/wagering' },
      /AUTH_ISSUER/,
    ],
    [
      'a key set url that is not a url',
      { AUTH_JWKS_URL: 'keys' },
      /AUTH_JWKS_URL/,
    ],
    [
      'an audience with spaces',
      { AUTH_AUDIENCE: 'wagering api' },
      /AUTH_AUDIENCE/,
    ],
    [
      'a stream sweep faster than 10 ms',
      { STREAM_SWEEP_INTERVAL_MS: '5' },
      /STREAM_SWEEP_INTERVAL_MS/,
    ],
    [
      'a stream heartbeat faster than one second',
      { STREAM_HEARTBEAT_INTERVAL_MS: '999' },
      /STREAM_HEARTBEAT_INTERVAL_MS/,
    ],
    [
      'a clock skew above five minutes',
      { AUTH_CLOCK_SKEW_SECONDS: '301' },
      /AUTH_CLOCK_SKEW_SECONDS/,
    ],
  ])('refuses %s', (_, environment, message) => {
    expect(() => loadConfig(environment)).toThrow(message);
  });

  test('fails fast naming every invalid variable without echoing its value', () => {
    const load = () =>
      loadConfig({
        DATABASE_URL: 'mysql://user:secret@db/wagering',
        DB_POOL_SIZE: '0',
        REFERENCE_MAX_ATTEMPTS: 'many',
      });

    expect(load).toThrow(InvalidConfigurationError);
    expect(load).toThrow(/DATABASE_URL.*DB_POOL_SIZE.*REFERENCE_MAX_ATTEMPTS/s);
    expect(load).not.toThrow(/secret/);
  });

  test('refuses a reference backoff whose cap is below its base', () => {
    expect(() =>
      loadConfig({
        REFERENCE_BACKOFF_BASE_MS: '5000',
        REFERENCE_BACKOFF_MAX_MS: '1000',
      }),
    ).toThrow(/REFERENCE_BACKOFF_MAX_MS/);
  });
});
