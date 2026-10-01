import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FrontendOnlyGuard } from '../../../common/guards/frontend-only.guard';
import { OpenfortUserGuard } from '../../../common/guards/openfort-user.guard';
import { StepUpGuard } from '../../../common/guards/step-up.guard';
import { FrontendOnly } from '../../../common/decorators/frontend-only.decorator';
import { RequireStepUp } from '../../../common/decorators/step-up.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { UsdcWalletPaymentService } from './usdc-wallet-payment.service';
import { UsdcWalletPayDto } from './dto/usdc-wallet-pay.dto';

/**
 * Phase 2B dashboard-only quote-bound wallet payment.
 * Intentionally omitted from openapi.yaml (not public API-key surface).
 *
 * POST requires IAM + FrontendOnly + real StepUp.
 * GET status requires IAM + FrontendOnly only (no StepUp).
 */
@Controller('v1/billing/invoices/:id/usdc')
export class UsdcWalletPaymentController {
  constructor(private readonly walletPayment: UsdcWalletPaymentService) {}

  /**
   * POST /v1/billing/invoices/:id/usdc/pay-from-wallet
   * Body: { paymentAttemptId } only.
   * Returns 202-shaped accepted/not-paid state (or idempotent existing).
   */
  @Post('pay-from-wallet')
  @FrontendOnly()
  @RequireStepUp()
  @UseGuards(OpenfortUserGuard, FrontendOnlyGuard, StepUpGuard)
  @Throttle({ short: { limit: 5, ttl: 60000 }, medium: { limit: 20, ttl: 3600000 } })
  async payFromWallet(
    @CurrentUser('id') userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UsdcWalletPayDto,
  ) {
    return this.walletPayment.payFromWallet(userId, id, body.paymentAttemptId);
  }

  /**
   * GET /v1/billing/invoices/:id/usdc/payment-status?paymentAttemptId=
   * Poll reserved wallet-payment state without StepUp.
   */
  @Get('payment-status')
  @FrontendOnly()
  @UseGuards(OpenfortUserGuard, FrontendOnlyGuard)
  @Throttle({ short: { limit: 30, ttl: 60000 }, medium: { limit: 120, ttl: 3600000 } })
  async paymentStatus(
    @CurrentUser('id') userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('paymentAttemptId', new ParseUUIDPipe()) paymentAttemptId: string,
  ) {
    return this.walletPayment.getPaymentStatus(userId, id, paymentAttemptId);
  }
}
