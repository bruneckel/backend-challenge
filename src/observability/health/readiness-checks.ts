import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@platform/config/app-config';
import { DatabaseHealth } from '@platform/database/database-health';
import { APP_CONFIG } from '@platform/tokens';
import { SqsHealth } from './sqs-health';

export type DependencyState = 'up' | 'down';

export interface DependencyChecks {
  database: DependencyState;
  sqs: DependencyState;
}

@Injectable()
export class ReadinessChecks {
  private cached: { at: number; checks: DependencyChecks } | undefined;

  constructor(
    private readonly database: DatabaseHealth,
    private readonly sqs: SqsHealth,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async current(): Promise<DependencyChecks> {
    const now = Date.now();
    if (
      this.cached !== undefined &&
      now - this.cached.at < this.config.observability.readinessCacheMs
    ) {
      return this.cached.checks;
    }
    const [database, sqs] = await Promise.all([
      this.database.isReachable(),
      this.sqs.isReachable(),
    ]);
    const checks: DependencyChecks = {
      database: database ? 'up' : 'down',
      sqs: sqs ? 'up' : 'down',
    };
    this.cached = { at: now, checks };
    return checks;
  }
}
