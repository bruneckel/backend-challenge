import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { lazyQueueUrl } from '@messaging/infrastructure/sqs/queue-provisioning';
import { createSqsClient } from '@messaging/infrastructure/sqs/sqs-client';
import type { AppConfig } from '@platform/config/app-config';
import { APP_CONFIG } from '@platform/tokens';

const CHECK_TIMEOUT_MS = 1000;

@Injectable()
export class SqsHealth implements OnApplicationShutdown {
  private readonly client: SQSClient;
  private readonly queueUrl: () => Promise<string>;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client = createSqsClient(config.sqs, {
      requestTimeoutMs: CHECK_TIMEOUT_MS,
      maxAttempts: 1,
    });
    this.queueUrl = lazyQueueUrl(this.client, config.sqs.commandsQueue);
  }

  async isReachable(): Promise<boolean> {
    try {
      await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: await this.queueUrl(),
          AttributeNames: ['QueueArn'],
        }),
        { abortSignal: AbortSignal.timeout(CHECK_TIMEOUT_MS) },
      );
      return true;
    } catch {
      return false;
    }
  }

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
