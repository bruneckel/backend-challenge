import { describe, expect, test } from 'bun:test';
import { withLogContext } from '@observability/logger/log-context';
import { PinoLogger } from '@observability/logger/pino-logger';

function capturingLogger() {
  const lines: Record<string, unknown>[] = [];
  const logger = new PinoLogger({
    role: 'api',
    instanceId: 'api-1',
    destination: {
      write(chunk: string) {
        lines.push(JSON.parse(chunk));
      },
    },
  });
  return { logger, lines };
}

describe('PinoLogger', () => {
  test('writes one JSON line with level, time, role, instance and message', () => {
    const { logger, lines } = capturingLogger();

    logger.info('wager transaction settled', { transactionId: 'tx-1' });

    expect(lines).toEqual([
      {
        level: 'info',
        time: expect.any(String),
        role: 'api',
        instanceId: 'api-1',
        transactionId: 'tx-1',
        msg: 'wager transaction settled',
      },
    ]);
  });

  test('adds the fields of the current log context', async () => {
    const { logger, lines } = capturingLogger();

    await withLogContext({ correlationId: 'corr-1' }, async () => {
      await Bun.sleep(1);
      withLogContext({ messageId: 'msg-1' }, () => logger.warn('retrying'));
    });

    expect(lines[0]).toMatchObject({
      level: 'warn',
      correlationId: 'corr-1',
      messageId: 'msg-1',
    });
  });

  test('redacts money, balances, payloads and player ids that slip into the fields', () => {
    const { logger, lines } = capturingLogger();

    logger.error('unexpected', {
      amount: '10.00',
      balance: '90.00',
      difference: '1.00',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      payload: '{"money":{"amount":"10.00"}}',
      walletId: 'wallet-1',
    });

    expect(lines[0]).toMatchObject({
      amount: '[redacted]',
      balance: '[redacted]',
      difference: '[redacted]',
      playerId: '[redacted]',
      payload: '[redacted]',
      walletId: 'wallet-1',
    });
  });
});
