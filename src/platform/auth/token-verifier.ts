import type { Principal } from './principal';

export interface TokenVerifier {
  verify(token: string): Promise<Principal>;
}
