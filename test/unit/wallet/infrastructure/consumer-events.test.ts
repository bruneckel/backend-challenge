import { describe, expect, test } from 'bun:test';
import { silentLogger } from '@shared/application/logger';
import { RecordingMetrics } from '@test/support/recording-metrics';
import { observeConsumerEvents } from '@wallet/infrastructure/messaging/wager-consumer.module';

const message = {
  sqsMessageId: 'sqs-1',
  receiptHandle: 'handle',
  body: '{}',
  groupId: 'wallet-1',
  receiveCount: 2,
};

describe('observeConsumerEvents', () => {
  test('counts retries by reason and dead letters by reason', () => {
    const metrics = new RecordingMetrics();
    const observe = observeConsumerEvents(silentLogger, metrics);

    observe({
      type: 'handled',
      message,
      disposition: { action: 'retry', delaySeconds: 4, reason: 'lock_timeout' },
    });
    observe({
      type: 'handled',
      message,
      disposition: { action: 'retry', delaySeconds: 4 },
    });
    observe({ type: 'dead_lettered', message, reason: 'WALLET_NOT_FOUND' });
    observe({
      type: 'handled',
      message,
      disposition: { action: 'acknowledge' },
    });

    expect(
      metrics.count('sqs_message_retries_total', { reason: 'lock_timeout' }),
    ).toBe(1);
    expect(
      metrics.count('sqs_message_retries_total', { reason: 'unexpected' }),
    ).toBe(1);
    expect(
      metrics.count('sqs_messages_dead_lettered_total', {
        reason: 'WALLET_NOT_FOUND',
      }),
    ).toBe(1);
  });
});
