import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ReadinessChecks } from './readiness-checks';
import { ReadinessState } from './readiness-state';
import { SqsHealth } from './sqs-health';

@Module({
  controllers: [HealthController],
  providers: [ReadinessState, SqsHealth, ReadinessChecks],
})
export class HealthModule {}
