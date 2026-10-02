import { Module } from '@nestjs/common';
import { WalletModule } from '@wallet/infrastructure/wallet.module';
import { WageringController } from './wagering.controller';
import { WalletsController } from './wallets.controller';

@Module({
  imports: [WalletModule],
  controllers: [WalletsController, WageringController],
})
export class WalletHttpModule {}
