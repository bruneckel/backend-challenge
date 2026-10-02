import { Injectable, type OnApplicationShutdown } from '@nestjs/common';

@Injectable()
export class ShutdownLogger implements OnApplicationShutdown {
  onApplicationShutdown(signal?: string): void {
    process.stdout.write(
      `${JSON.stringify({ level: 'info', msg: 'shutdown complete', signal: signal ?? null })}\n`,
    );
  }
}
