import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Rate-limits by API key prefix when X-API-Key auth is used, falling back to
 * client IP for JWT-authenticated requests. This ensures each API key gets its
 * own independent quota rather than sharing a bucket with other keys from the
 * same IP address.
 */
@Injectable()
export class ApiKeyThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, any>): Promise<string> {
    const keyPrefix: string | undefined = req.apiKeyRecord?.keyPrefix;
    if (keyPrefix) return keyPrefix;
    return super.getTracker(req);
  }
}
