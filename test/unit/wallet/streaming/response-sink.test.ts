import { describe, expect, test } from 'bun:test';
import {
  ResponseSink,
  type StreamingRequest,
  type StreamingResponse,
} from '@wallet/infrastructure/streaming/response-sink';

function fakes(destroyed = false) {
  const calls: string[] = [];
  const socketListeners = new Set<() => void>();
  const request: StreamingRequest = {
    socket: {
      destroyed,
      once: (_event, listener) => socketListeners.add(listener),
      off: (_event, listener) => socketListeners.delete(listener),
    },
  };
  const response: StreamingResponse = {
    setHeader: (name, value) => calls.push(`header ${name}: ${value}`),
    writeHead: (status) => calls.push(`status ${status}`),
    flushHeaders: () => calls.push('flush'),
    write: (chunk) => {
      calls.push(`write ${chunk}`);
      return true;
    },
    end: () => calls.push('end'),
    once: () => undefined,
  };
  return { calls, socketListeners, request, response };
}

describe('ResponseSink', () => {
  test('sets the stream headers before it writes the status', () => {
    const { calls, request, response } = fakes();

    new ResponseSink(request, response).open();

    expect(calls).toEqual([
      'header content-type: text/event-stream; charset=utf-8',
      'header cache-control: no-cache, no-transform',
      'header x-accel-buffering: no',
      'status 200',
      'flush',
    ]);
  });

  test('reports a client that left before anyone listened', () => {
    const { request, response, socketListeners } = fakes(true);
    let closed = 0;

    new ResponseSink(request, response).onClose(() => {
      closed += 1;
    });

    expect(closed).toBe(1);
    expect(socketListeners.size).toBe(0);
  });

  test('stops listening to the socket when the server ends the stream', () => {
    const { calls, request, response, socketListeners } = fakes();
    const sink = new ResponseSink(request, response);
    sink.onClose(() => undefined);

    sink.end();

    expect(socketListeners.size).toBe(0);
    expect(calls).toEqual(['end']);
  });
});
