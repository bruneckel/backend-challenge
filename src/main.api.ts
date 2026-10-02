import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { createApiApplication } from '@app/api-application';
import { loadConfig } from '@platform/config/app-config';

const log = (entry: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(entry)}\n`);

try {
  const config = loadConfig(process.env);
  const app = await createApiApplication(config);
  await app.listen(config.port, '0.0.0.0');
  const { port } = app.getHttpServer().address() as AddressInfo;
  log({ level: 'info', msg: 'api listening', port, instanceId: config.instanceId });
} catch (error) {
  log({ level: 'error', msg: 'api failed to start', error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}
