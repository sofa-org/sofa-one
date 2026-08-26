import { THROTTLER_SKIP } from '@nestjs/throttler/dist/throttler.constants';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { StripeWebhookController } from './stripe-webhook.controller';

describe('StripeWebhookController', () => {
  const webhookService = {
    handleWebhook: jest.fn(),
  };

  let controller: StripeWebhookController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new StripeWebhookController(webhookService as any);
  });

  it('delegates to the webhook service with the raw body and signature', async () => {
    webhookService.handleWebhook.mockResolvedValue(undefined);
    const rawBody = Buffer.from('{"event":"payload"}');
    const req = {
      rawBody,
      headers: { 'stripe-signature': 't=1,v1=sig' },
    };

    const result = await controller.handleStripe(req as any);

    expect(webhookService.handleWebhook).toHaveBeenCalledWith(rawBody, 't=1,v1=sig');
    expect(result).toEqual({ received: true });
  });

  it('passes undefined signature when the header is missing', async () => {
    webhookService.handleWebhook.mockResolvedValue(undefined);
    const req = { rawBody: Buffer.from('{}'), headers: {} };

    await controller.handleStripe(req as any);

    expect(webhookService.handleWebhook).toHaveBeenCalledWith(Buffer.from('{}'), undefined);
  });

  it('is public and skips throttling', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, controller.handleStripe)).toBe(true);
    // The global throttler defines two named throttlers; both must be skipped.
    expect(Reflect.getMetadata(THROTTLER_SKIP + 'short', controller.handleStripe)).toBe(true);
    expect(Reflect.getMetadata(THROTTLER_SKIP + 'medium', controller.handleStripe)).toBe(true);
  });
});
