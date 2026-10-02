import type { LoggerService } from '@nestjs/common';
import type { Logger } from '@shared/application/logger';

export class NestLoggerAdapter implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, context?: string): void {
    this.logger.info(String(message), { context });
  }

  warn(message: unknown, context?: string): void {
    this.logger.warn(String(message), { context });
  }

  error(message: unknown, trace?: string, context?: string): void {
    this.logger.error(String(message), { context, trace });
  }

  debug(): void {}

  verbose(): void {}
}
