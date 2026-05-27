import { Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { WithdrawalPolicyService } from './withdrawal-policy.service';
import { StepUpModule } from '../step-up/step-up.module';
import { SecurityEventModule } from '../security-events/security-event.module';
import { EoaExecutionModule } from '../eoa-execution/eoa-execution.module';

@Module({
  imports: [StepUpModule, SecurityEventModule, EoaExecutionModule],
  controllers: [WalletController],
  providers: [WalletService, WithdrawalPolicyService],
})
export class WalletModule {}
