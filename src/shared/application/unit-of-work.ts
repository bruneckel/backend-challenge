export interface UnitOfWork<TScope> {
  run<T>(work: (scope: TScope) => Promise<T>): Promise<T>;
}

export class NestedUnitOfWorkError extends Error {
  constructor() {
    super('A unit of work cannot start inside another one');
    this.name = 'NestedUnitOfWorkError';
  }
}
