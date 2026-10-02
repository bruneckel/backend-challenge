import { ApplicationError } from '@shared/application/application-error';

export class MessageIdConflictError extends ApplicationError {
  override readonly code = 'MESSAGE_ID_CONFLICT';

  constructor(readonly messageId: string) {
    super(`Message ${messageId} was already received with a different payload`);
  }
}
