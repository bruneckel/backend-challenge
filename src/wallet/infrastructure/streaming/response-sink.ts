import type { EventSink } from './wallet-event-hub';

export interface StreamingRequest {
  readonly socket: {
    readonly destroyed: boolean;
    once(event: 'close', listener: () => void): unknown;
    off(event: 'close', listener: () => void): unknown;
  };
}

export interface StreamingResponse {
  setHeader(name: string, value: string): unknown;
  writeHead(status: number): unknown;
  flushHeaders(): void;
  write(chunk: string): boolean;
  end(): unknown;
  once(event: 'drain', listener: () => void): unknown;
}

export class ResponseSink implements EventSink {
  private readonly closeListeners: (() => void)[] = [];

  constructor(
    private readonly request: StreamingRequest,
    private readonly response: StreamingResponse,
  ) {}

  open(): void {
    this.response.setHeader('content-type', 'text/event-stream; charset=utf-8');
    this.response.setHeader('cache-control', 'no-cache, no-transform');
    this.response.setHeader('x-accel-buffering', 'no');
    this.response.writeHead(200);
    this.response.flushHeaders();
  }

  write(chunk: string): boolean {
    return this.response.write(chunk);
  }

  onDrain(listener: () => void): void {
    this.response.once('drain', listener);
  }

  onClose(listener: () => void): void {
    if (this.request.socket.destroyed) {
      listener();
      return;
    }
    this.closeListeners.push(listener);
    this.request.socket.once('close', listener);
  }

  end(): void {
    for (const listener of this.closeListeners.splice(0)) {
      this.request.socket.off('close', listener);
    }
    this.response.end();
  }
}
