import { ConfigService } from '@nestjs/config';
import * as Stripe from 'stripe';
import { STRIPE_API_VERSION, STRIPE_CLIENT } from './stripe.constants';

/**
 * Provides the pinned Stripe client, or `null` when `STRIPE_SECRET_KEY` is not
 * configured. The app and all non-payment functionality must keep working
 * without Stripe; callers that require Stripe fail closed with a 503.
 */
export const stripeClientProvider = {
  provide: STRIPE_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Stripe | null => {
    const secretKey = config.get<string>('stripe.secretKey');
    if (!secretKey) return null;
    return new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION, typescript: true });
  },
};
