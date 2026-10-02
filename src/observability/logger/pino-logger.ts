import pino, { type DestinationStream } from 'pino';
import type { LogFields, Logger } from '@shared/application/logger';
import { currentLogContext } from './log-context';

const SENSITIVE_FIELDS = [
  'amount',
  'balance',
  'balanceBefore',
  'balanceAfter',
  'difference',
  'money',
  'payload',
  'body',
  'playerId',
  'authorization',
  'password',
  'secretAccessKey',
];

export const REDACTED_PATHS = SENSITIVE_FIELDS.flatMap((field) => [
  field,
  `*.${field}`,
]);

export interface PinoLoggerOptions {
  role: string;
  instanceId: string;
  level?: string;
  destination?: DestinationStream;
}

export class PinoLogger implements Logger {
  private readonly logger: pino.Logger;

  constructor(options: PinoLoggerOptions) {
    this.logger = pino(
      {
        level: options.level ?? 'info',
        base: { role: options.role, instanceId: options.instanceId },
        messageKey: 'msg',
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: { level: (label) => ({ level: label }) },
        mixin: () => ({ ...currentLogContext() }),
        redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
      },
      options.destination ?? pino.destination({ dest: 1, sync: true }),
    );
  }

  info(message: string, fields: LogFields = {}): void {
    this.logger.info({ ...fields }, message);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.logger.warn({ ...fields }, message);
  }

  error(message: string, fields: LogFields = {}): void {
    this.logger.error({ ...fields }, message);
  }
}
