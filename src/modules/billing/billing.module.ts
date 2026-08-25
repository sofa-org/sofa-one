import { Module } from '@nestjs/common';
import { PrismaModule } from '../../core/database/prisma.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { BillingReconciliationService } from './billing-reconciliation.service';

@Module({
  imports: [PrismaModule],
  controllers: [BillingController],
  providers: [BillingService, BillingReconciliationService],
  exports: [BillingService, BillingReconciliationService],
})
export class BillingModule {}
