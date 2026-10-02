import Big from 'big.js';
import { DomainError } from '../../../shared/domain/domain-error';

const Decimal = Big();
Decimal.strict = true;

const ZERO = new Decimal('0');
const AMOUNT_PATTERN = /^(0|[1-9]\d*)\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class InvalidMoneyError extends DomainError {
  override readonly code = 'INVALID_MONEY';
}

export class CurrencyMismatchError extends DomainError {
  override readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, received: string) {
    super(`Currency mismatch: expected ${expected}, received ${received}`);
  }
}

function assertCurrency(currency: unknown): asserts currency is string {
  if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
    throw new InvalidMoneyError('Currency must be a three-letter uppercase ISO-4217 code');
  }
}

export class Money {
  private readonly value: Big.Big;

  private constructor(
    value: Big.Big,
    readonly currency: string,
  ) {
    this.value = value.eq(ZERO) ? ZERO : value;
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    const { amount, currency } = props;
    if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError('Amount must be a non-negative decimal string with exactly two decimal places');
    }
    assertCurrency(currency);
    return new Money(new Decimal(amount), currency);
  }

  static zero(currency: string): Money {
    assertCurrency(currency);
    return new Money(ZERO, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.neg(), this.currency);
  }

  isZero(): boolean {
    return this.value.eq(ZERO);
  }

  isPositive(): boolean {
    return this.value.gt(ZERO);
  }

  isNegative(): boolean {
    return this.value.lt(ZERO);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lt(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.eq(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  valueOf(): never {
    throw new TypeError('Money cannot be converted to a JavaScript number; use toString() or toJSON()');
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
