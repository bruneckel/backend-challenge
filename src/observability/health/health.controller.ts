import { Controller, Get, Res } from '@nestjs/common';
import { Public } from '@platform/auth/auth.guard';
import { type DependencyChecks, ReadinessChecks } from './readiness-checks';
import { ReadinessState } from './readiness-state';

interface StatusWriter {
  status(code: number): unknown;
}

export type ReadinessReport =
  | { status: 'shutting_down' }
  | { status: 'ready' | 'not_ready'; checks: DependencyChecks };

@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly readiness: ReadinessState,
    private readonly checks: ReadinessChecks,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(
    @Res({ passthrough: true }) response: StatusWriter,
  ): Promise<ReadinessReport> {
    if (this.readiness.isShuttingDown) {
      response.status(503);
      return { status: 'shutting_down' };
    }
    const checks = await this.checks.current();
    const ready = checks.database === 'up' && checks.sqs === 'up';
    if (!ready) {
      response.status(503);
    }
    return { status: ready ? 'ready' : 'not_ready', checks };
  }
}
