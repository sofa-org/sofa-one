import { Body, Controller, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FrontendOnlyGuard } from '../../../common/guards/frontend-only.guard';
import { OpenfortUserGuard } from '../../../common/guards/openfort-user.guard';
import { FrontendOnly } from '../../../common/decorators/frontend-only.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { UsdcPaymentService } from './usdc-payment.service';
import { UsdcQuoteDto } from './dto/usdc-quote.dto';
import { UsdcClaimDto } from './dto/usdc-claim.dto';
import { UsdcCancelDto } from './dto/usdc-cancel.dto';

/**
 * Dashboard-only native USDC invoice payment routes. These are intentionally
 * NOT part of the public API-key spec (openapi.yaml) and require an Openfort
 * IAM bearer token plus the FrontendOnlyGuard origin/referer check. All
 * payment facts are server-derived; the client only supplies a verified chain
 * selector (quote), `{ paymentAttemptId, txHash }` (claim), or
 * `{ paymentAttemptId }` (cancel of a clean pending quote).
 */
@Controller('v1/billing/invoices/:id/usdc')
export class UsdcPaymentController {
  constructor(private readonly usdcPaymentService: UsdcPaymentService) {}

  /**
   * POST /v1/billing/invoices/:id/usdc/quote — creates (or reuses) a pending
   * USDC payment attempt for a finalized, unpaid USD invoice owned by the
   * user. Returns a safe quote (token, treasury, expected payer, exact amount,
   * TTL, confirmations); never returns logs, calldata, RPC details, Openfort
   * IDs, or secrets.
   */
  @Post('quote')
  @FrontendOnly()
  @UseGuards(OpenfortUserGuard, FrontendOnlyGuard)
  async quote(
    @CurrentUser('id') userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UsdcQuoteDto,
  ) {
    return this.usdcPaymentService.quote(userId, id, body.chainId);
  }

  /**
   * POST /v1/billing/invoices/:id/usdc/claim — verifies a user-submitted
   * transaction hash against the attempt's server-side quote snapshot and
   * advances the payment lifecycle (confirming → settled, or review/expired/
   * failed on any mismatch). Retryable outcomes never fabricate a payment.
   *
   * Claim performs RPC lookups (receipt + chain head), so it carries a tight
   * route-level throttle to bound RPC amplification; the Dashboard guards are
   * unchanged.
   */
  @Post('claim')
  @FrontendOnly()
  @UseGuards(OpenfortUserGuard, FrontendOnlyGuard)
  @Throttle({ short: { limit: 5, ttl: 60000 }, medium: { limit: 20, ttl: 3600000 } })
  async claim(
    @CurrentUser('id') userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UsdcClaimDto,
  ) {
    return this.usdcPaymentService.claim(userId, id, body);
  }

  /**
   * POST /v1/billing/invoices/:id/usdc/cancel — BILL-003 user cancel of a clean
   * evidence-free pending USDC quote. Body is only `{ paymentAttemptId }`.
   * No RPC/provider calls; fail closed on confirming, reservation, any hash/
   * receipt/evidence, or inconsistent state. Idempotent when already cancelled.
   * Intentionally omitted from openapi.yaml (dashboard-only).
   */
  @Post('cancel')
  @FrontendOnly()
  @UseGuards(OpenfortUserGuard, FrontendOnlyGuard)
  @Throttle({ short: { limit: 10, ttl: 60000 }, medium: { limit: 60, ttl: 3600000 } })
  async cancel(
    @CurrentUser('id') userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UsdcCancelDto,
  ) {
    return this.usdcPaymentService.cancel(userId, id, body.paymentAttemptId);
  }
}
