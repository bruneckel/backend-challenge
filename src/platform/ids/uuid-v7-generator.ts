import type { IdGenerator } from '@shared/application/id-generator';

export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
