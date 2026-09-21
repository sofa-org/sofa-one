import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../../core/database/prisma.module';
import { SecurityEventModule } from '../security-events/security-event.module';
import { SessionKeyModule } from '../session-key/session-key.module';
import { StepUpModule } from '../step-up/step-up.module';
import { WithdrawalDestinationModule } from '../withdrawal-destination/withdrawal-destination.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { BillingReconciliationService } from './billing-reconciliation.service';
import { BillingEntitlementService } from './billing-entitlement.service';
import { BillingDebtService } from './billing-debt.service';
import { BillingPlanChangeService } from './billing-plan-change.service';
import { InvoiceSettlementService } from './invoice-settlement.service';
import { BillingWorkerService } from './billing-worker.service';
import { InvoicePdfService } from './invoice-pdf.service';
import { StripePaymentService } from './stripe/stripe-payment.service';
import { StripeWebhookService } from './stripe/stripe-webhook.service';
import { StripeWebhookController } from './stripe/stripe-webhook.controller';
import { stripeClientProvider } from './stripe/stripe-client.provider';
import { StripeSubscriptionSyncService } from './stripe/stripe-subscription-sync.service';
import { StripeAutoSubscriptionService } from './stripe/stripe-auto-subscription.service';
import { StripeCheckoutSessionCleanupService } from './stripe/stripe-checkout-session-cleanup.service';
import { UsdcPaymentController } from './onchain/usdc-payment.controller';
import { UsdcPaymentService } from './onchain/usdc-payment.service';
import { UsdcWalletPaymentController } from './onchain/usdc-wallet-payment.controller';
import { UsdcWalletPaymentService } from './onchain/usdc-wallet-payment.service';
import { ViemUsdcReceiptProvider } from './onchain/usdc-receipt.provider';
import { USDC_RECEIPT_PROVIDER } from './onchain/usdc.constants';

@Module({
  imports: [
    PrismaModule,
    SecurityEventModule,
    ScheduleModule.forRoot(),
    // Phase 2B wallet-payment: destination leaf + session-key gate + real StepUp
    // (StepUpGuard on pay-from-wallet). No WalletModule — avoids Wallet↔Billing cycle.
    WithdrawalDestinationModule,
    SessionKeyModule,
    StepUpModule,
  ],
  controllers: [
    BillingController,
    StripeWebhookController,
    UsdcPaymentController,
    UsdcWalletPaymentController,
  ],
  providers: [
    BillingService,
    BillingReconciliationService,
    BillingEntitlementService,
    BillingDebtService,
    BillingPlanChangeService,
    InvoiceSettlementService,
    BillingWorkerService,
    InvoicePdfService,
    StripePaymentService,
    StripeWebhookService,
    StripeSubscriptionSyncService,
    StripeAutoSubscriptionService,
    StripeCheckoutSessionCleanupService,
    stripeClientProvider,
    UsdcPaymentService,
    UsdcWalletPaymentService,
    { provide: USDC_RECEIPT_PROVIDER, useClass: ViemUsdcReceiptProvider },
  ],
  exports: [
    BillingService,
    BillingReconciliationService,
    BillingEntitlementService,
    BillingDebtService,
    BillingPlanChangeService,
    InvoiceSettlementService,
    StripePaymentService,
    StripeSubscriptionSyncService,
    StripeAutoSubscriptionService,
    UsdcWalletPaymentService,
  ],
})
export class BillingModule {}
