import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { configureHttpApplication } from '@app/http-application';
import { WorkerModule } from '@app/worker.module';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { type AppConfig, loadConfig } from '@platform/config/app-config';

export const log = (entry: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(entry)}\n`);

export async function startWorkerWith(override: (builder: TestingModuleBuilder, config: AppConfig) => TestingModuleBuilder): Promise<void> {
  const config = loadConfig(process.env);
  const moduleRef = await override(Test.createTestingModule({ imports: [WorkerModule.forRoot(config)] }), config).compile();
  const app = configureHttpApplication(moduleRef.createNestApplication({ logger: ['error', 'warn'] }));
  await app.listen(0, '127.0.0.1');
  log({ level: 'info', msg: 'worker listening', port: (app.getHttpServer().address() as AddressInfo).port });
}
