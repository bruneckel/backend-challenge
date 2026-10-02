export type TransientReason =
  | 'lock_timeout'
  | 'deadlock'
  | 'serialization_failure'
  | 'statement_timeout'
  | 'connection';

export class TransientFailure extends Error {
  constructor(
    readonly reason: TransientReason,
    options?: ErrorOptions,
  ) {
    super(`Transient infrastructure failure: ${reason}`, options);
    this.name = 'TransientFailure';
  }
}
