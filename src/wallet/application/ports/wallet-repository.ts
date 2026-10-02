import { ApplicationError } from '@shared/application/application-error';
import type { Wallet } from '@wallet/domain/wallet/wallet';

export interface WalletAlreadyExistsOptions extends ErrorOptions {
  walletId?: string;
}

export class WalletAlreadyExistsError extends ApplicationError {
  override readonly code = 'WALLET_ALREADY_EXISTS';
  readonly walletId: string | undefined;

  constructor(
    readonly playerId: string,
    readonly currency: string,
    { walletId, ...options }: WalletAlreadyExistsOptions = {},
  ) {
    super(`Player ${playerId} already has a ${currency} wallet`, options);
    this.walletId = walletId;
  }

  override get details(): Readonly<Record<string, string>> | undefined {
    return this.walletId === undefined
      ? undefined
      : { walletId: this.walletId };
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
  findByOwner(playerId: string, currency: string): Promise<Wallet | null>;
  lockForUpdate(id: string): Promise<Wallet | null>;
  insert(wallet: Wallet): Promise<void>;
  applyBalanceChange(wallet: Wallet, expectedVersion: number): Promise<void>;
}
