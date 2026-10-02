import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { CorrelationId } from '@platform/http/correlation';
import type { ReconciliationReport } from '@wallet/application/use-cases/reconcile-wallet';
import { ReconcileWallet } from '@wallet/application/use-cases/reconcile-wallet';
import { OpenWallet } from '@wallet/application/use-cases/open-wallet';
import { WalletQueries } from '@wallet/application/use-cases/wallet-queries';
import type { LedgerEntryView, WalletView } from '@wallet/application/views';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor';
import {
  type LedgerQueryParams,
  type OpenWalletBody,
  ledgerQuerySchema,
  openWalletSchema,
  uuidParam,
} from './schemas';

export type CreatedWallet = Omit<WalletView, 'updatedAt'>;

export interface LedgerResponse {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWallet,
    private readonly queries: WalletQueries,
    private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(201)
  async open(
    @Body({ schema: openWalletSchema }) body: OpenWalletBody,
    @CorrelationId() correlationId: string,
  ): Promise<CreatedWallet> {
    const wallet = await this.openWallet.execute({ ...body, correlationId });
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance, version: wallet.version, createdAt: wallet.createdAt };
  }

  @Get(':walletId')
  show(@Param('walletId', { schema: uuidParam }) walletId: string): Promise<WalletView> {
    return this.queries.getWallet(walletId);
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId', { schema: uuidParam }) walletId: string,
    @Query({ schema: ledgerQuerySchema }) query: LedgerQueryParams,
  ): Promise<LedgerResponse> {
    const beforeVersion = query.cursor === undefined ? undefined : decodeLedgerCursor(query.cursor, walletId);
    const page = await this.queries.getLedger(walletId, { beforeVersion, limit: query.limit });
    return {
      items: page.items,
      nextCursor: page.nextBeforeVersion === null ? null : encodeLedgerCursor(walletId, page.nextBeforeVersion),
    };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId', { schema: uuidParam }) walletId: string): Promise<ReconciliationReport> {
    return this.reconcileWallet.execute(walletId);
  }
}
