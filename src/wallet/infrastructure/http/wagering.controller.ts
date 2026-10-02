import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { ProviderIdentityPort } from '@platform/auth/provider-identity';
import { CorrelationId } from '@platform/http/correlation';
import { IdempotencyKey } from '@platform/http/idempotency-key';
import { PROVIDER_IDENTITY } from '@platform/tokens';
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
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @IdempotencyKey() idempotencyKey: string,
    @CorrelationId() correlationId: string,
    @Body({ schema: wagerOperationSchema }) body: WagerOperationBody,
    @Req() request: unknown,
    @Res({ passthrough: true }) response: ResultWriter,
  ): Promise<TransactionResult> {
    this.identity.assertMayActFor(body.providerId, request);
    const result = await this.submitTransaction.execute({
      ...body,
      kind: body.kind as SubmittableKind,
      idempotencyKey,
      correlationId,
      causationId: idempotencyKey,
    });
    response.status(HTTP_STATUS[result.status]);
    if (result.status === 'PENDING_REFERENCE') {
      response.setHeader('Location', `/wagering/transactions/${result.transactionId}`);
    }
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  show(@Param('transactionId', { schema: uuidParam }) transactionId: string): Promise<TransactionView> {
    return this.queries.getTransaction(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  showByExternalId(
    @Param('providerId', { schema: providerIdParam }) providerId: string,
    @Param('externalTransactionId', { schema: externalTransactionIdParam }) externalTransactionId: string,
  ): Promise<TransactionView> {
    return this.queries.getTransactionByExternalId(providerId, externalTransactionId);
  }
}
