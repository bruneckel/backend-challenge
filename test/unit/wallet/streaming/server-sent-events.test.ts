import { describe, expect, test } from 'bun:test';
import { RequestValidationError } from '@platform/http/request-errors';
import {
  KEEP_ALIVE,
  parseLastEventId,
  retryAfter,
  serverSentEvent,
} from '@wallet/infrastructure/streaming/server-sent-events';

describe('serverSentEvent', () => {
  test('writes the id, the event name and the data as one JSON line', () => {
    expect(
      serverSentEvent(7, 'ledger-entry', { walletVersion: 7, note: 'a\nb' }),
    ).toBe(
      'id: 7\nevent: ledger-entry\ndata: {"walletVersion":7,"note":"a\\nb"}\n\n',
    );
  });

  test('keeps the connection alive with a comment', () => {
    expect(KEEP_ALIVE).toBe(': keep-alive\n\n');
  });

  test('tells the client how long to wait before reconnecting', () => {
    expect(retryAfter(3000)).toBe('retry: 3000\n\n');
  });
});

describe('parseLastEventId', () => {
  test.each([undefined, ''])('treats %p as a new subscription', (header) => {
    expect(parseLastEventId(header)).toBeUndefined();
  });

  test.each([
    ['0', 0],
    ['42', 42],
    ['2147483647', 2147483647],
  ])('reads %p as wallet version %p', (header, version) => {
    expect(parseLastEventId(header)).toBe(version);
  });

  test.each(['-1', '1.5', 'abc', ' 3', '2147483648', '00000000001'])(
    'refuses %p',
    (header) => {
      expect(() => parseLastEventId(header)).toThrow(RequestValidationError);
    },
  );
});
