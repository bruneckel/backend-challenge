import { ApplicationError } from '@shared/application/application-error';
import type { Wallet } from '@wallet/domain/wallet/wallet';

export class WalletAlreadyExistsError extends ApplicationError {
  override readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(
    readonly playerId: string,
    readonly currency: string,
    options?: ErrorOptions,
  ) {
    super(`Player ${playerId} already has a ${currency} wallet`, options);
  }
}

export class StaleWalletVersionError extends ApplicationError {
  override readonly code = 'STALE_WALLET_VERSION';

  constructor(
    readonly walletId: string,
    readonly expectedVersion: number,
  ) {
    super(`Wallet ${walletId} is no longer at version ${expectedVersion}`);
  }
}

export interface WalletRepository {
  findById(id: string): Promise<Wallet | null>;
  lockForUpdate(id: string): Promise<Wallet | null>;
  insert(wallet: Wallet): Promise<void>;
  applyBalanceChange(wallet: Wallet, expectedVersion: number): Promise<void>;
}
