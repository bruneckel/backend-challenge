export interface ExponentialBackoffOptions {
  baseMs: number;
  maxMs: number;
  factor?: number;
  random?: () => number;
}

export class ExponentialBackoff {
  private constructor(
    private readonly baseMs: number,
    private readonly maxMs: number,
    private readonly factor: number,
    private readonly random: () => number,
  ) {}

  static create(options: ExponentialBackoffOptions): ExponentialBackoff {
    const factor = options.factor ?? 2;
    if (!(options.baseMs > 0)) {
      throw new RangeError('baseMs must be positive');
    }
    if (!(options.maxMs >= options.baseMs)) {
      throw new RangeError('maxMs must be greater than or equal to baseMs');
    }
    if (!(factor >= 1)) {
      throw new RangeError('factor must be at least 1');
    }
    return new ExponentialBackoff(options.baseMs, options.maxMs, factor, options.random ?? Math.random);
  }

  delayFor(attempt: number): number {
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new RangeError('attempt must be a positive integer');
    }
    const fullDelay = Math.min(this.baseMs * this.factor ** (attempt - 1), this.maxMs);
    return Math.round(fullDelay * (0.5 + 0.5 * this.random()));
  }

  nextAttemptAt(now: Date, attempt: number): Date {
    return new Date(now.getTime() + this.delayFor(attempt));
  }
}
