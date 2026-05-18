import { ThrottlerGuard } from '@nestjs/throttler';

import { ApiKeyThrottlerGuard } from './api-key-throttler.guard';

class TestableApiKeyThrottlerGuard extends ApiKeyThrottlerGuard {
  track(req: Record<string, any>) {
    return this.getTracker(req);
  }
}

describe('ApiKeyThrottlerGuard', () => {
  let guard: TestableApiKeyThrottlerGuard;

  beforeEach(() => {
    guard = new TestableApiKeyThrottlerGuard(
      {} as any,
      {} as any,
      {} as any,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('tracks API-key requests by key prefix', async () => {
    const superGetTracker = jest.spyOn(
      ThrottlerGuard.prototype as any,
      'getTracker',
    );

    await expect(
      guard.track({
        apiKeyRecord: { keyPrefix: 'sk_abc123' },
        ip: '203.0.113.10',
      }),
    ).resolves.toBe('sk_abc123');
    expect(superGetTracker).not.toHaveBeenCalled();
  });

  it('falls back to the parent tracker when no API key prefix is present', async () => {
    const superGetTracker = jest
      .spyOn(ThrottlerGuard.prototype as any, 'getTracker')
      .mockResolvedValue('parent-tracker');

    const req = { ip: '203.0.113.10' };

    await expect(guard.track(req)).resolves.toBe('parent-tracker');
    expect(superGetTracker).toHaveBeenCalledWith(req);
  });

  it('falls back to the parent tracker for blank key prefixes', async () => {
    const superGetTracker = jest
      .spyOn(ThrottlerGuard.prototype as any, 'getTracker')
      .mockResolvedValue('parent-tracker');

    const req = { apiKeyRecord: { keyPrefix: '' }, ip: '203.0.113.10' };

    await expect(guard.track(req)).resolves.toBe('parent-tracker');
    expect(superGetTracker).toHaveBeenCalledWith(req);
  });
});
