export interface ProviderIdentityPort {
  authenticate(request: unknown): boolean;
  assertMayActFor(providerId: string, request: unknown): void;
}

export class AnonymousProviderIdentity implements ProviderIdentityPort {
  authenticate(): boolean {
    return true;
  }

  assertMayActFor(): void {}
}
