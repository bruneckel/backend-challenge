import { Controller, Get, Res } from '@nestjs/common';
import { Public } from '@platform/auth/auth.guard';
import { PrometheusMetrics } from './prometheus-metrics';

interface HeaderWriter {
  setHeader(name: string, value: string): unknown;
}

@Public()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: PrometheusMetrics) {}

  @Get()
  expose(@Res({ passthrough: true }) response: HeaderWriter): Promise<string> {
    response.setHeader('content-type', this.metrics.registry.contentType);
    return this.metrics.registry.metrics();
  }
}
