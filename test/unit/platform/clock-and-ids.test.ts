import { describe, expect, test } from 'bun:test';
import { UuidV7Generator } from '@platform/ids/uuid-v7-generator';
import { SystemClock } from '@platform/time/system-clock';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('UuidV7Generator', () => {
  test('generates distinct version 7 UUIDs in creation order', () => {
    const generator = new UuidV7Generator();

    const ids = Array.from({ length: 100 }, () => generator.next());

    expect(ids.every((id) => UUID_V7.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(100);
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('SystemClock', () => {
  test('tells the current time', () => {
    const before = Date.now();

    const now = new SystemClock().now().getTime();

    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});
