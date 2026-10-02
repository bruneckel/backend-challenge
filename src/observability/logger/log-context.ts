import { AsyncLocalStorage } from 'node:async_hooks';
import type { LogFields } from '@shared/application/logger';

const storage = new AsyncLocalStorage<LogFields>();

export function currentLogContext(): LogFields {
  return storage.getStore() ?? {};
}

export function withLogContext<T>(fields: LogFields, work: () => T): T {
  return storage.run({ ...currentLogContext(), ...fields }, work);
}
