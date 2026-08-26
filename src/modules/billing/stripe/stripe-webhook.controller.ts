import { Controller, Post, RawBodyRequest, Req } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';
import { Public } from '../../../common/decorators/public.decorator';
import { StripeWebhookService } from './stripe-webhook.service';

/**
 * Public Stripe webhook endpoint. Intentionally NOT part of the public
 * API-key spec (openapi.yaml) and NOT protected by OpenfortUserGuard,
 * FrontendOnlyGuard, or ApiKeyAuthGuard — Stripe signs the payload and the
 * service verifies the signature from `req.rawBody` (never re-parsed).
 * Throttling is skipped so Stripe retries are never rate-limited.
 */
@Controller('v1/billing/webhooks')
export class StripeWebhookController {
  constructor(private readonly webhookService: StripeWebhookService) {}

  @Post('stripe')
  @Public()
  // The global throttler defines two named throttlers ('short', 'medium');
  // skip both so Stripe retries are never rate-limited.
  @SkipThrottle({ short: true, medium: true })
  async handleStripe(@Req() req: RawBodyRequest<Request>): Promise<{ received: true }> {
    const signature = req.headers['stripe-signature'];
    await this.webhookService.handleWebhook(
      req.rawBody,
      typeof signature === 'string' ? signature : undefined,
    );
    return { received: true };
  }
}
