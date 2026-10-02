import { type BeforeApplicationShutdown, Injectable } from '@nestjs/common';

@Injectable()
export class ReadinessState implements BeforeApplicationShutdown {
  private shuttingDown = false;

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  beginShutdown(): void {
    this.shuttingDown = true;
  }

  beforeApplicationShutdown(): void {
    this.beginShutdown();
  }
}
