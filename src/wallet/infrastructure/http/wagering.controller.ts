import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import { AccessDeniedError } from '@platform/auth/auth-errors';
import { CurrentPrincipal } from '@platform/auth/auth.guard';
import type { Principal } from '@platform/auth/principal';
import { assertActsAs, mayRead } from '@platform/auth/provider-access';
import { CorrelationId } from '@platform/http/correlation';
import { IdempotencyKey } from '@platform/http/idempotency-key';
import { TransactionNotFoundError } from '@wallet/application/errors';
import type { TransactionResult } from '@wallet/application/transaction-result';
import { SubmitWagerTransaction } from '@wallet/application/use-cases/submit-wager-transaction';
import { WalletQueries } from '@wallet/application/use-cases/wallet-queries';
import type { TransactionView } from '@wallet/application/views';
import type { SubmittableKind } from '@wallet/domain/transaction/wager-transaction';
import {
  type WagerOperationBody,
  externalTransactionIdParam,
  providerIdParam,
  uuidParam,
  wagerOperationSchema,
} from './schemas';

interface ResultWriter {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

const HTTP_STATUS: Readonly<Record<TransactionResult['status'], number>> = {
  PROCESSED: 200,
  PENDING: 202,
  PENDING_REFERENCE: 202,
  REJECTED: 422,
  FAILED: 500,
};

@Controller()
export class WageringController {
  constructor(
    private readonly submitTransaction: SubmitWagerTransaction,
    private readonly queries: WalletQueries,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @IdempotencyKey() idempotencyKey: string,
    @CorrelationId() correlationId: string,
    @Body({ schema: wagerOperationSchema }) body: WagerOperationBody,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) response: ResultWriter,
  ): Promise<TransactionResult> {
    assertActsAs(principal, body.providerId);
    const result = await this.submitTransaction.execute({
      ...body,
      kind: body.kind as SubmittableKind,
      idempotencyKey,
      correlationId,
      causationId: idempotencyKey,
    });
    response.status(HTTP_STATUS[result.status]);
    if (result.status === 'PENDING_REFERENCE') {
      response.setHeader(
        'Location',
        `/wagering/transactions/${result.transactionId}`,
      );
    }
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  async show(
    @Param('transactionId', { schema: uuidParam }) transactionId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<TransactionView> {
    const transaction = await this.queries.getTransaction(transactionId);
    if (!mayRead(principal, transaction.providerId)) {
      throw new TransactionNotFoundError(transactionId);
    }
    return transaction;
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  showByExternalId(
    @Param('providerId', { schema: providerIdParam }) providerId: string,
    @Param('externalTransactionId', { schema: externalTransactionIdParam })
    externalTransactionId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<TransactionView> {
    if (!mayRead(principal, providerId)) {
      throw new AccessDeniedError();
    }
    return this.queries.getTransactionByExternalId(
      providerId,
      externalTransactionId,
    );
  }
}
