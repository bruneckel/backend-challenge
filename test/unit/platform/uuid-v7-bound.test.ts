import { describe, expect, test } from 'bun:test';
import { uuidV7LowerBound } from '@platform/ids/uuid-v7-bound';

describe('uuidV7LowerBound', () => {
  const cutoff = new Date('2026-09-26T12:00:00.000Z');

  test('sorts after every UUIDv7 generated before the instant', () => {
    for (let index = 0; index < 1000; index += 1) {
      const earlier = Bun.randomUUIDv7(
        'hex',
        new Date(cutoff.getTime() - 1 - index),
      );
      expect(earlier < uuidV7LowerBound(cutoff)).toBe(true);
    }
  });

  test('sorts before every UUIDv7 generated at or after the instant', () => {
    for (let index = 0; index < 1000; index += 1) {
      const later = Bun.randomUUIDv7(
        'hex',
        new Date(cutoff.getTime() + (index % 2)),
      );
      expect(later >= uuidV7LowerBound(cutoff)).toBe(true);
    }
  });

  test('is a well-formed UUIDv7', () => {
    expect(uuidV7LowerBound(cutoff)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7000-8000-000000000000$/,
    );
  });
});
