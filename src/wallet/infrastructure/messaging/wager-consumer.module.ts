import {
  Inject,
  Injectable,
  Module,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { SQSClient } from "@aws-sdk/client-sqs";
import {
  type ConsumerEvent,
  MessageBatchConsumer,
} from "@messaging/infrastructure/sqs/message-batch-consumer";
import { lazyQueueUrl } from "@messaging/infrastructure/sqs/queue-provisioning";
import { createSqsClient } from "@messaging/infrastructure/sqs/sqs-client";
import type { AppConfig } from "@platform/config/app-config";
import { PollingLoop } from "@platform/lifecycle/polling-loop";
import { APP_CONFIG, CLOCK, PAYLOAD_FINGERPRINTER } from "@platform/tokens";
import type { Clock } from "@shared/application/clock";
import type { PayloadFingerprinter } from "@shared/application/payload-fingerprinter";
import { ExponentialBackoff } from "@shared/domain/exponential-backoff";
import { SubmitWagerTransaction } from "@wallet/application/use-cases/submit-wager-transaction";
import { WalletModule } from "@wallet/infrastructure/wallet.module";
import { WagerMessageHandler } from "./wager-message-handler";

export const CONSUMER_SQS_CLIENT = Symbol("CONSUMER_SQS_CLIENT");

const log = (entry: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify(entry)}\n`);

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function logConsumerEvent(event: ConsumerEvent): void {
  switch (event.type) {
    case "handled":
      if (event.disposition.action === "dead_letter") {
        log({
          level: "warn",
          msg: "message sent to the dead-letter queue",
          sqsMessageId: event.message.sqsMessageId,
          reason: event.disposition.reason,
        });
      } else if (event.disposition.action === "retry") {
        log({
          level: "warn",
          msg: "message will be retried",
          sqsMessageId: event.message.sqsMessageId,
          receiveCount: event.message.receiveCount,
          delaySeconds: event.disposition.delaySeconds,
        });
      }
      return;
    case "handler_failed":
    case "dead_letter_failed":
      log({
        level: "error",
        msg: event.type.replace("_", " "),
        sqsMessageId: event.message.sqsMessageId,
        errorName: errorName(event.error),
      });
      return;
    case "queue_call_failed":
      log({
        level: "error",
        msg: "queue call failed",
        operation: event.operation,
        errorName: errorName(event.error),
      });
  }
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

  constructor(consumer: MessageBatchConsumer) {
    this.loop = new PollingLoop({
      step: async (signal) => (await consumer.consumeOnce(signal)) > 0,
      idleDelayMs: 0,
      errorBackoff: ExponentialBackoff.create({ baseMs: 1000, maxMs: 30_000 }),
      onError: (error, consecutiveFailures) =>
        log({
          level: "error",
          msg: "wager consumer paused",
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
          onEvent: logConsumerEvent,
        }),
      inject: [CONSUMER_SQS_CLIENT, WagerMessageHandler, APP_CONFIG],
    },
    WagerConsumerRunner,
  ],
})
export class WagerConsumerModule {}
