import { Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';

const CHECK_TIMEOUT_MS = 1000;

@Injectable()
export class DatabaseHealth {
  constructor(private readonly orm: MikroORM) {}

  async isReachable(): Promise<boolean> {
    try {
      await this.orm.em.fork().execute('select 1', [], { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
      return true;
    } catch {
      return false;
    }
  }
}
