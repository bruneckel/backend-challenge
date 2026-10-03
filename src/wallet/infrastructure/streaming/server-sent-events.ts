import { RequestValidationError } from '@platform/http/request-errors';

const VERSION = /^\d{1,10}$/;
const MAX_VERSION = 2_147_483_647;

export const KEEP_ALIVE = ': keep-alive\n\n';

export function serverSentEvent(
  id: number,
  event: string,
  data: unknown,
): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function retryAfter(milliseconds: number): string {
  return `retry: ${milliseconds}\n\n`;
}

export function parseLastEventId(
  header: string | undefined,
): number | undefined {
  if (header === undefined || header === '') {
    return undefined;
  }
  if (!VERSION.test(header) || Number(header) > MAX_VERSION) {
    throw new RequestValidationError('header', [
      {
        message: 'must be a wallet version received from this stream',
        path: ['last-event-id'],
      },
    ]);
  }
  return Number(header);
}
