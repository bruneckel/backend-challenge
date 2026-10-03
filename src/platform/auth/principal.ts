export interface Principal {
  readonly subject: string;
  readonly providerId: string | undefined;
  readonly roles: readonly string[];
}

export const OPERATOR = 'operator';
export const METRICS_READER = 'metrics-reader';

export type Role = typeof OPERATOR | typeof METRICS_READER;
