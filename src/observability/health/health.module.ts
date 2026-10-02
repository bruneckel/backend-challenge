import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ReadinessState } from './readiness-state';

@Module({
  controllers: [HealthController],
  providers: [ReadinessState],
})
export class HealthModule {}
