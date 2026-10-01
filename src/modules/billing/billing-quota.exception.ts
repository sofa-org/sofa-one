import { HttpException, HttpStatus } from '@nestjs/common';

/** Stable machine-readable code for quota-exceeded responses. */
export const BILLING_QUOTA_EXCEEDED_CODE = 'BILLING_API_QUOTA_EXCEEDED';

/**
 * Raised when a billing quota is exceeded (HTTP 429). Carries the metric,
 * limit, period, and an optional retryAfter hint. The limit is serialized
 * JSON-safe (bigint -> string). Infrastructure errors must never be wrapped in
 * this exception — it is reserved for genuine quota enforcement.
 */
export class BillingQuotaExceededException extends HttpException {
  constructor(
    metric: string,
    limit: number | bigint | null,
    period: string,
    retryAfterSeconds?: number,
  ) {
    super(
      {
        code: BILLING_QUOTA_EXCEEDED_CODE,
        message: 'Billing quota exceeded',
        metric,
        limit: typeof limit === 'bigint' ? limit.toString() : limit,
        period,
        ...(retryAfterSeconds !== undefined ? { retryAfter: retryAfterSeconds } : {}),
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
