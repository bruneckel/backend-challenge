import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { createApiApplication } from '@app/api-application';
import { PinoLogger } from '@observability/logger/pino-logger';
import { loadConfig } from '@platform/config/app-config';

try {
  const config = loadConfig(process.env);
  const logger = new PinoLogger({
    role: 'api',
    instanceId: config.instanceId,
    level: config.observability.logLevel,
  });
  const app = await createApiApplication(config, { logger });
  await app.listen(config.port, '0.0.0.0');
  const { port } = app.getHttpServer().address() as AddressInfo;
  logger.info('api listening', { port });
} catch (error) {
  new PinoLogger({ role: 'api', instanceId: 'unknown' }).error(
    'api failed to start',
    { error: error instanceof Error ? error.message : String(error) },
  );
  process.exit(1);
}
