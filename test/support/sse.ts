import { waitUntil } from './async';

export interface StreamedEvent {
  id: string | undefined;
  event: string | undefined;
  data: any;
}

export interface ParsedStream {
  events: StreamedEvent[];
  comments: number;
  retry: number | undefined;
}

function parseBlock(
  block: string,
  into: ParsedStream,
): StreamedEvent | undefined {
  const fields = new Map<string, string>();
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) {
      into.comments += 1;
      continue;
    }
    const separator = line.indexOf(': ');
    fields.set(line.slice(0, separator), line.slice(separator + 2));
  }
  if (fields.has('retry')) {
    into.retry = Number(fields.get('retry'));
  }
  if (!fields.has('data')) {
    return undefined;
  }
  const event: StreamedEvent = {
    id: fields.get('id'),
    event: fields.get('event'),
    data: JSON.parse(fields.get('data')!),
  };
  into.events.push(event);
  return event;
}

export function parseServerSentEvents(text: string): ParsedStream {
  const parsed: ParsedStream = { events: [], comments: 0, retry: undefined };
  for (const block of text.split('\n\n')) {
    if (block !== '') {
      parseBlock(block, parsed);
    }
  }
  return parsed;
}

export interface EventStream extends ParsedStream {
  readonly status: number;
  readonly headers: Headers;
  readonly problem: any;
  readonly closed: boolean;
  waitFor(count: number, timeoutMs?: number): Promise<StreamedEvent[]>;
  waitForClose(timeoutMs?: number): Promise<void>;
  close(): void;
}

export interface EventStreamOptions {
  onEvent?: (event: StreamedEvent, receivedAt: number) => void;
}

export async function openEventStream(
  url: string,
  headers: Record<string, string>,
  options: EventStreamOptions = {},
): Promise<EventStream> {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  const parsed: ParsedStream = { events: [], comments: 0, retry: undefined };
  let closed = false;
  let problem: any;
  if (response.status !== 200 || response.body === null) {
    const text = await response.text();
    problem = text === '' ? undefined : JSON.parse(text);
    closed = true;
  } else {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      let pending = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          pending += decoder.decode(value, { stream: true });
          let boundary = pending.indexOf('\n\n');
          while (boundary >= 0) {
            const event = parseBlock(pending.slice(0, boundary), parsed);
            if (event !== undefined) {
              options.onEvent?.(event, Date.now());
            }
            pending = pending.slice(boundary + 2);
            boundary = pending.indexOf('\n\n');
          }
        }
      } catch {
        return;
      } finally {
        closed = true;
      }
    })();
  }
  return {
    status: response.status,
    headers: response.headers,
    problem,
    get events() {
      return parsed.events;
    },
    get comments() {
      return parsed.comments;
    },
    get retry() {
      return parsed.retry;
    },
    get closed() {
      return closed;
    },
    async waitFor(count, timeoutMs = 10_000) {
      await waitUntil(() => parsed.events.length >= count, {
        timeoutMs,
        intervalMs: 10,
        description: `${count} streamed events`,
      });
      return parsed.events;
    },
    async waitForClose(timeoutMs = 10_000) {
      await waitUntil(() => closed, {
        timeoutMs,
        intervalMs: 10,
        description: 'the stream to close',
      });
    },
    close() {
      controller.abort();
    },
  };
}
