import { Module } from '@nestjs/common';
import { HealthController } from './observability/health/health.controller';
import { ShutdownLogger } from './platform/lifecycle/shutdown-logger';

@Module({
  controllers: [HealthController],
  providers: [ShutdownLogger],
})
export class ApiModule {}
