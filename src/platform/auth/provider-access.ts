import { AccessDeniedError } from './auth-errors';
import { OPERATOR, type Principal } from './principal';

export function assertActsAs(principal: Principal, providerId: string): void {
  if (principal.providerId !== providerId) {
    throw new AccessDeniedError();
  }
}

export function mayRead(principal: Principal, providerId: string): boolean {
  return (
    principal.providerId === providerId || principal.roles.includes(OPERATOR)
  );
}
