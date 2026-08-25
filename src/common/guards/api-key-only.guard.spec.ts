import { UnauthorizedException } from '@nestjs/common';
import { ApiKeyOnlyGuard } from './api-key-only.guard';

function contextWithRequest(request: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as any;
}

describe('ApiKeyOnlyGuard', () => {
  it('rejects requests without an apiKeyRecord', () => {
    const guard = new ApiKeyOnlyGuard();

    expect(() => guard.canActivate(contextWithRequest({}))).toThrow(UnauthorizedException);
  });

  it('allows requests with an apiKeyRecord', () => {
    const guard = new ApiKeyOnlyGuard();

    expect(guard.canActivate(contextWithRequest({ apiKeyRecord: { id: 'key-1' } }))).toBe(true);
  });
});
