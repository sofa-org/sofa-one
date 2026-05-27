import { Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { WithdrawalPolicyService } from './withdrawal-policy.service';
import { StepUpModule } from '../step-up/step-up.module';
import { SecurityEventModule } from '../security-events/security-event.module';

@Module({
  imports: [StepUpModule, SecurityEventModule],
  controllers: [WalletController],
  providers: [WalletService, WithdrawalPolicyService],
})
export class WalletModule {}
