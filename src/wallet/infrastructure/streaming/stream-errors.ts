import { ApplicationError } from '@shared/application/application-error';

export class StreamCapacityExceededError extends ApplicationError {
  override readonly code = 'STREAM_CAPACITY_EXCEEDED';

  constructor() {
    super('This instance has no room for another event stream');
  }
}
