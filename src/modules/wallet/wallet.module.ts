import { Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { WithdrawalPolicyService } from './withdrawal-policy.service';
import { SigningPolicyService } from './signing-policy.service';
import { StepUpModule } from '../step-up/step-up.module';
import { SecurityEventModule } from '../security-events/security-event.module';
import { EoaExecutionModule } from '../eoa-execution/eoa-execution.module';
import { SessionKeyModule } from '../session-key/session-key.module';
import { BillingModule } from '../billing/billing.module';
import { WithdrawalDestinationModule } from '../withdrawal-destination/withdrawal-destination.module';

@Module({
  imports: [
    StepUpModule,
    SecurityEventModule,
    EoaExecutionModule,
    SessionKeyModule,
    BillingModule,
    // Shared destination/cooldown leaf + user advisory lock (BILL-016).
    WithdrawalDestinationModule,
  ],
  controllers: [WalletController],
  providers: [WalletService, WithdrawalPolicyService, SigningPolicyService],
})
export class WalletModule {}
