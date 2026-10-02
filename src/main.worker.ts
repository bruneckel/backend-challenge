import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { createWorkerApplication } from '@app/worker-application';
import { loadConfig } from '@platform/config/app-config';

const log = (entry: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify(entry)}\n`);

try {
  const config = loadConfig(process.env);
  const app = await createWorkerApplication(config);
  await app.listen(config.port, '0.0.0.0');
  const { port } = app.getHttpServer().address() as AddressInfo;
  log({
    level: 'info',
    msg: 'worker listening',
    port,
    instanceId: config.instanceId,
    publisher: config.worker.publisherEnabled,
    consumer: config.worker.consumerEnabled,
    scheduler: config.worker.schedulerEnabled,
  });
} catch (error) {
  log({
    level: 'error',
    msg: 'worker failed to start',
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
}
