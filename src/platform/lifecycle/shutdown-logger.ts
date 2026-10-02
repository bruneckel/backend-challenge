import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { LOGGER } from '@platform/tokens';
import type { Logger } from '@shared/application/logger';

@Injectable()
export class ShutdownLogger implements OnApplicationShutdown {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  onApplicationShutdown(signal?: string): void {
    this.logger.info('shutdown complete', { signal: signal ?? null });
  }
}
