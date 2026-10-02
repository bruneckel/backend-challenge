import { parseArgs } from 'node:util';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { queueUrlOf } from '@messaging/infrastructure/sqs/queue-provisioning';
import { createSqsClient } from '@messaging/infrastructure/sqs/sqs-client';
import { loadConfig } from '@platform/config/app-config';

const { values } = parseArgs({
  options: {
    wallet: { type: 'string' },
    player: { type: 'string' },
    kind: { type: 'string', default: 'BET' },
    amount: { type: 'string', default: '10.00' },
    currency: { type: 'string', default: 'BRL' },
    provider: { type: 'string', default: 'provider-a' },
    reference: { type: 'string' },
  },
});

if (values.wallet === undefined || values.player === undefined) {
  process.stderr.write(
    'usage: bun run demo:send-message --wallet <walletId> --player <playerId> [--kind BET] [--amount 10.00] [--currency BRL] [--reference <externalTransactionId>]\n',
  );
  process.exit(1);
}

const config = loadConfig(process.env);
const client = createSqsClient(config.sqs);
const externalTransactionId = `demo-${Bun.randomUUIDv7()}`;
const messageId = `msg-${Bun.randomUUIDv7()}`;
const message = {
  messageId,
  type: 'WagerTransactionRequested',
  occurredAt: new Date().toISOString(),
  data: {
    providerId: values.provider,
    externalTransactionId,
    idempotencyKey: `${values.provider}:${externalTransactionId}`,
    playerId: values.player,
    walletId: values.wallet,
    roundId: 'demo-round',
    gameId: 'demo-game',
    kind: values.kind,
    money: { amount: values.amount, currency: values.currency },
    ...(values.reference === undefined
      ? {}
      : { referenceExternalTransactionId: values.reference }),
  },
};

const { MessageId } = await client.send(
  new SendMessageCommand({
    QueueUrl: await queueUrlOf(client, config.sqs.commandsQueue),
    MessageBody: JSON.stringify(message),
    MessageGroupId: values.wallet,
    MessageDeduplicationId: messageId,
  }),
);
process.stdout.write(
  `${JSON.stringify({ level: 'info', msg: 'demo message sent', messageId, sqsMessageId: MessageId, externalTransactionId })}\n`,
);
client.destroy();
