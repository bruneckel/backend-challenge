import {
  Inject,
  Injectable,
  Module,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { SQSClient } from '@aws-sdk/client-sqs';
import {
  type ConsumerEvent,
  MessageBatchConsumer,
} from '@messaging/infrastructure/sqs/message-batch-consumer';
import { lazyQueueUrl } from '@messaging/infrastructure/sqs/queue-provisioning';
import { createSqsClient } from '@messaging/infrastructure/sqs/sqs-client';
import type { AppConfig } from '@platform/config/app-config';
import { PollingLoop } from '@platform/lifecycle/polling-loop';
import {
  APP_CONFIG,
  CLOCK,
  LOGGER,
  METRICS,
  PAYLOAD_FINGERPRINTER,
} from '@platform/tokens';
import type { Clock } from '@shared/application/clock';
import type { Logger } from '@shared/application/logger';
import type { Metrics } from '@shared/application/metrics';
import type { PayloadFingerprinter } from '@shared/application/payload-fingerprinter';
import { ExponentialBackoff } from '@shared/domain/exponential-backoff';
import { SubmitWagerTransaction } from '@wallet/application/use-cases/submit-wager-transaction';
import { WalletModule } from '@wallet/infrastructure/wallet.module';
import { WagerMessageHandler } from './wager-message-handler';

export const CONSUMER_SQS_CLIENT = Symbol('CONSUMER_SQS_CLIENT');

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function observeConsumerEvents(
  logger: Logger,
  metrics: Metrics,
): (event: ConsumerEvent) => void {
  return (event) => {
    switch (event.type) {
      case 'handled':
        if (event.disposition.action === 'retry') {
          const reason = event.disposition.reason ?? 'unexpected';
          metrics.increment('sqs_message_retries_total', { reason });
          logger.warn('message will be retried', {
            sqsMessageId: event.message.sqsMessageId,
            attempt: event.message.receiveCount,
            delaySeconds: event.disposition.delaySeconds,
            reason,
          });
        }
        return;
      case 'dead_lettered':
        metrics.increment('sqs_messages_dead_lettered_total', {
          reason: event.reason,
        });
        logger.warn('message moved to the dead-letter queue', {
          sqsMessageId: event.message.sqsMessageId,
          attempt: event.message.receiveCount,
          reason: event.reason,
        });
        return;
      case 'handler_failed':
        logger.error('message handler failed', {
          sqsMessageId: event.message.sqsMessageId,
          errorName: errorName(event.error),
        });
        return;
      case 'dead_letter_failed':
        logger.error('dead-letter queue refused the message', {
          sqsMessageId: event.message.sqsMessageId,
          errorName: errorName(event.error),
        });
        return;
      case 'queue_call_failed':
        logger.error('queue call failed', {
          operation: event.operation,
          errorName: errorName(event.error),
        });
    }
  };
}

@Injectable()
class ConsumerClientLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(CONSUMER_SQS_CLIENT) private readonly client: SQSClient,
  ) {}

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}

@Injectable()
export class WagerConsumerRunner
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly loop: PollingLoop;

  constructor(consumer: MessageBatchConsumer, @Inject(LOGGER) logger: Logger) {
    this.loop = new PollingLoop({
      step: async (signal) => (await consumer.consumeOnce(signal)) > 0,
      idleDelayMs: 0,
      errorBackoff: ExponentialBackoff.create({ baseMs: 1000, maxMs: 30_000 }),
      onError: (error, consecutiveFailures) =>
        logger.error('wager consumer paused', {
          errorName: errorName(error),
          consecutiveFailures,
        }),
    });
  }

  onApplicationBootstrap(): void {
    this.loop.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }
}

@Module({
  imports: [WalletModule],
  providers: [
    {
      provide: CONSUMER_SQS_CLIENT,
      useFactory: (config: AppConfig) =>
        createSqsClient(config.sqs, {
          requestTimeoutMs: config.consumer.receiveTimeoutMs,
        }),
      inject: [APP_CONFIG],
    },
    ConsumerClientLifecycle,
    {
      provide: WagerMessageHandler,
      useFactory: (
        submit: SubmitWagerTransaction,
        fingerprinter: PayloadFingerprinter,
        clock: Clock,
        config: AppConfig,
      ) =>
        new WagerMessageHandler({
          submit,
          fingerprinter,
          clock,
          consumerName: config.consumer.name,
          maxAttempts: config.consumer.maxAttempts,
          retryBackoff: ExponentialBackoff.create({
            baseMs: config.consumer.retryBaseMs,
            maxMs: config.consumer.retryMaxMs,
          }),
        }),
      inject: [
        SubmitWagerTransaction,
        PAYLOAD_FINGERPRINTER,
        CLOCK,
        APP_CONFIG,
      ],
    },
    {
      provide: MessageBatchConsumer,
      useFactory: (
        client: SQSClient,
        handler: WagerMessageHandler,
        config: AppConfig,
        logger: Logger,
        metrics: Metrics,
      ) =>
        new MessageBatchConsumer({
          client,
          queueUrl: lazyQueueUrl(client, config.sqs.commandsQueue),
          deadLetterQueueUrl: lazyQueueUrl(client, config.sqs.deadLetterQueue),
          handler: handler.handle,
          instanceId: config.instanceId,
          batchSize: config.consumer.batchSize,
          waitTimeSeconds: config.consumer.waitTimeSeconds,
          visibilityTimeoutSeconds: config.consumer.visibilityTimeoutSeconds,
          heartbeatIntervalMs: config.consumer.heartbeatIntervalMs,
          maxConcurrentGroups: config.consumer.maxConcurrentGroups,
          onEvent: observeConsumerEvents(logger, metrics),
        }),
      inject: [
        CONSUMER_SQS_CLIENT,
        WagerMessageHandler,
        APP_CONFIG,
        LOGGER,
        METRICS,
      ],
    },
    WagerConsumerRunner,
  ],
})
export class WagerConsumerModule {}
