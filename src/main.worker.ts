import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { createWorkerApplication } from '@app/worker-application';
import { PinoLogger } from '@observability/logger/pino-logger';
import { loadConfig } from '@platform/config/app-config';

try {
  const config = loadConfig(process.env);
  const logger = new PinoLogger({
    role: 'worker',
    instanceId: config.instanceId,
    level: config.observability.logLevel,
  });
  const app = await createWorkerApplication(config, { logger });
  await app.listen(config.port, '0.0.0.0');
  const { port } = app.getHttpServer().address() as AddressInfo;
  logger.info('worker listening', {
    port,
    publisher: config.worker.publisherEnabled,
    consumer: config.worker.consumerEnabled,
    scheduler: config.worker.schedulerEnabled,
  });
} catch (error) {
  new PinoLogger({ role: 'worker', instanceId: 'unknown' }).error(
    'worker failed to start',
    { error: error instanceof Error ? error.message : String(error) },
  );
  process.exit(1);
}
