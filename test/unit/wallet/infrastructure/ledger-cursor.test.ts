import { describe, expect, test } from 'bun:test';
import { InvalidCursorError, decodeLedgerCursor, encodeLedgerCursor } from '@wallet/infrastructure/http/ledger-cursor';

const WALLET = '0192f291-27dd-7d3f-8071-5f8685deef37';
const OTHER_WALLET = '0192f291-27dd-7d3f-8071-5f8685deef38';
const encoded = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

describe('ledger cursor', () => {
  test('is an opaque base64url token that leads back to the version to continue from', () => {
    const cursor = encodeLedgerCursor(WALLET, 7);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeLedgerCursor(cursor, WALLET)).toBe(7);
  });

  test.each([
    ['not base64url', 'not a cursor!'],
    ['not JSON', encoded('hello')],
    ['missing the version', encoded({ walletId: WALLET })],
    ['pointing before the first version', encoded({ walletId: WALLET, beforeVersion: 1 })],
    ['carrying a fractional version', encoded({ walletId: WALLET, beforeVersion: 2.5 })],
    ['carrying extra fields', encoded({ walletId: WALLET, beforeVersion: 3, admin: true })],
    ['issued for another wallet', encoded({ walletId: OTHER_WALLET, beforeVersion: 3 })],
  ])('rejects a cursor %s', (_, cursor) => {
    expect(() => decodeLedgerCursor(cursor, WALLET)).toThrow(InvalidCursorError);
  });
});
