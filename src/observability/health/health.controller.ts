import { Controller, Get, Res } from '@nestjs/common';
import { Public } from '@platform/auth/auth.guard';
import { DatabaseHealth } from '@platform/database/database-health';
import { ReadinessState } from './readiness-state';

interface StatusWriter {
  status(code: number): unknown;
}

export type ReadinessReport =
  | { status: 'shutting_down' }
  | { status: 'ready' | 'not_ready'; checks: { database: 'up' | 'down' } };

@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly readiness: ReadinessState,
    private readonly database: DatabaseHealth,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: StatusWriter): Promise<ReadinessReport> {
    if (this.readiness.isShuttingDown) {
      response.status(503);
      return { status: 'shutting_down' };
    }
    const database = (await this.database.isReachable()) ? 'up' : 'down';
    if (database === 'down') {
      response.status(503);
    }
    return { status: database === 'up' ? 'ready' : 'not_ready', checks: { database } };
  }
}
