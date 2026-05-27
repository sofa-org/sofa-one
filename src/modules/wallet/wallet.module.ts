import { Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { StepUpModule } from '../step-up/step-up.module';

@Module({
  imports: [StepUpModule],
  controllers: [WalletController],
  providers: [WalletService],
})
export class WalletModule {}
