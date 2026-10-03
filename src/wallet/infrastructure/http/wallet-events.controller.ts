import { Controller, Get, Headers, Param, Req, Res } from '@nestjs/common';
import { CurrentPrincipal, RequiresRole } from '@platform/auth/auth.guard';
import { OPERATOR, type Principal } from '@platform/auth/principal';
import {
  ResponseSink,
  type StreamingRequest,
  type StreamingResponse,
} from '@wallet/infrastructure/streaming/response-sink';
import { parseLastEventId } from '@wallet/infrastructure/streaming/server-sent-events';
import { WalletEventHub } from '@wallet/infrastructure/streaming/wallet-event-hub';
import { uuidParam } from './schemas';

@RequiresRole(OPERATOR)
@Controller('wallets')
export class WalletEventsController {
  constructor(private readonly hub: WalletEventHub) {}

  @Get(':walletId/events')
  stream(
    @Param('walletId', { schema: uuidParam }) walletId: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() request: StreamingRequest,
    @Res() response: StreamingResponse,
  ): Promise<void> {
    return this.hub.open({
      walletId,
      lastEventId: parseLastEventId(lastEventId),
      expiresAt: principal.expiresAt,
      sink: new ResponseSink(request, response),
    });
  }
}
