import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money } from '@wallet/domain/money/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

describe('Money.from', () => {
  test.each(['0.00', '0.01', '25.00', '1000.00', '99999999999999999.99', '123456789012345678901.10'])(
    'accepts %p',
    (amount) => {
      expect(brl(amount).toJSON()).toEqual({ amount, currency: 'BRL' });
    },
  );

  test.each([
    '',
    'NaN',
    'Infinity',
    '-Infinity',
    '1e3',
    '1E3',
    '1.0e2',
    '-1.00',
    '+1.00',
    '1',
    '1.5',
    '1.000',
    '10.005',
    '01.00',
    '00.00',
    ' 1.00',
    '1.00 ',
    '1,00',
    '.50',
    '1.',
    '0x10',
  ])('rejects the amount %p', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('rejects a JavaScript number even when it looks like money', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test.each(['brl', 'BR', 'BRLL', '', 'B1L', ' BRL'])('rejects the currency %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  test('creates zero in the given currency', () => {
    expect(Money.zero('USD').toJSON()).toEqual({ amount: '0.00', currency: 'USD' });
  });

  test('rejects an invalid currency for zero', () => {
    expect(() => Money.zero('usd')).toThrow(InvalidMoneyError);
  });
});

describe('Money arithmetic', () => {
  test('adds without floating point error', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
  });

  test('stays exact at the storage limit', () => {
    expect(brl('99999999999999999.98').add(brl('0.01')).toString()).toBe('99999999999999999.99');
  });

  test('subtracts', () => {
    expect(brl('100.00').subtract(brl('80.00')).toString()).toBe('20.00');
  });

  test('can hold a negative result produced by an operation', () => {
    const difference = brl('20.00').subtract(brl('80.00'));

    expect(difference.toString()).toBe('-60.00');
    expect(difference.isNegative()).toBe(true);
    expect(difference.toJSON()).toEqual({ amount: '-60.00', currency: 'BRL' });
  });

  test('negates', () => {
    expect(brl('25.00').negate().toString()).toBe('-25.00');
    expect(brl('25.00').negate().negate().toString()).toBe('25.00');
  });

  test('never prints negative zero', () => {
    expect(Money.zero('BRL').negate().toString()).toBe('0.00');
    expect(brl('5.00').negate().add(brl('5.00')).toString()).toBe('0.00');
    expect(brl('5.00').subtract(brl('5.00')).negate().toString()).toBe('0.00');
  });

  test('throws a currency mismatch on add, subtract and comparison', () => {
    expect(() => brl('1.00').add(usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd('1.00'))).toThrow(CurrencyMismatchError);
  });
});

describe('Money comparisons', () => {
  test('reports the sign', () => {
    const zero = Money.zero('BRL');
    const cent = brl('0.01');
    const negative = cent.negate();

    expect([zero.isZero(), zero.isPositive(), zero.isNegative()]).toEqual([true, false, false]);
    expect([cent.isZero(), cent.isPositive(), cent.isNegative()]).toEqual([false, true, false]);
    expect([negative.isZero(), negative.isPositive(), negative.isNegative()]).toEqual([false, false, true]);
  });

  test('compares amounts', () => {
    expect(brl('79.99').isLessThan(brl('80.00'))).toBe(true);
    expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
    expect(brl('80.01').isLessThan(brl('80.00'))).toBe(false);
  });

  test('is equal only with the same amount and currency', () => {
    expect(brl('1.00').equals(brl('1.00'))).toBe(true);
    expect(brl('1.00').equals(brl('1.01'))).toBe(false);
    expect(brl('1.00').equals(usd('1.00'))).toBe(false);
  });
});

describe('Money immutability and serialization', () => {
  test('returns new instances and leaves the operands unchanged', () => {
    const balance = brl('100.00');
    const bet = brl('80.00');

    const remaining = balance.subtract(bet);

    expect(remaining).not.toBe(balance);
    expect(balance.toString()).toBe('100.00');
    expect(bet.toString()).toBe('80.00');
  });

  test('is frozen', () => {
    expect(Object.isFrozen(brl('1.00'))).toBe(true);
  });

  test('serializes as MoneyProps with a two-decimal string', () => {
    expect(JSON.stringify(brl('25.00'))).toBe('{"amount":"25.00","currency":"BRL"}');
  });

  test('refuses to be coerced into a JavaScript number', () => {
    const money: unknown = brl('25.00');

    expect(() => Number(money)).toThrow(TypeError);
    expect(() => (money as number) + 1).toThrow(TypeError);
  });
});
