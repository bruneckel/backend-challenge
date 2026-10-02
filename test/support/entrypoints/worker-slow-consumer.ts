import { InboxMessage } from '@messaging/domain/inbox-message';
import type { AppConfig } from '@platform/config/app-config';
import { APP_CONFIG, CLOCK, PAYLOAD_FINGERPRINTER } from '@platform/tokens';
import type { Clock } from '@shared/application/clock';
import type { PayloadFingerprinter } from '@shared/application/payload-fingerprinter';
import { ExponentialBackoff } from '@shared/domain/exponential-backoff';
import {
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
} from '@wallet/application/use-cases/submit-wager-transaction';
import { WagerMessageHandler } from '@wallet/infrastructure/messaging/wager-message-handler';
import { log, startWorkerWith } from './start-worker-with';

const slowMs = Number.parseInt(process.env.TEST_SLOW_HANDLER_MS ?? '1500', 10);

await startWorkerWith((builder) =>
  builder.overrideProvider(WagerMessageHandler).useFactory({
    factory: (
      submit: SubmitWagerTransaction,
      fingerprinter: PayloadFingerprinter,
      clock: Clock,
      config: AppConfig,
    ) => {
      const slowSubmit = {
        async executeDelivery(
          command: SubmitWagerTransactionCommand,
          delivery: InboxMessage,
        ) {
          log({
            level: 'info',
            msg: 'processing started',
            messageId: delivery.messageId,
          });
          await Bun.sleep(slowMs);
          const outcome = await submit.executeDelivery(command, delivery);
          log({
            level: 'info',
            msg: 'processing finished',
            messageId: delivery.messageId,
          });
          return outcome;
        },
      } as unknown as SubmitWagerTransaction;
      return new WagerMessageHandler({
        submit: slowSubmit,
        fingerprinter,
        clock,
        consumerName: config.consumer.name,
        maxAttempts: config.consumer.maxAttempts,
        retryBackoff: ExponentialBackoff.create({
          baseMs: config.consumer.retryBaseMs,
          maxMs: config.consumer.retryMaxMs,
        }),
      });
    },
    inject: [SubmitWagerTransaction, PAYLOAD_FINGERPRINTER, CLOCK, APP_CONFIG],
  }),
);
