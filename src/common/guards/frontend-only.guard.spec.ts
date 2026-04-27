import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { FrontendOnlyGuard } from './frontend-only.guard';

function contextWithHeaders(headers: Record<string, string | undefined>) {
  return {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as any;
}

describe('FrontendOnlyGuard', () => {
  function createGuard(corsOrigin = 'https://app.example.com') {
    return new FrontendOnlyGuard(
      { getAllAndOverride: jest.fn().mockReturnValue(true) } as unknown as Reflector,
      { get: jest.fn().mockReturnValue(corsOrigin) } as unknown as ConfigService,
    );
  }

  it('allows an exact configured origin', () => {
    const guard = createGuard();

    expect(guard.canActivate(contextWithHeaders({ origin: 'https://app.example.com' }))).toBe(true);
  });

  it('rejects a prefixed attacker origin', () => {
    const guard = createGuard();

    expect(() =>
      guard.canActivate(contextWithHeaders({ origin: 'https://app.example.com.evil.com' })),
    ).toThrow(ForbiddenException);
  });

  it('uses referer origin with exact matching', () => {
    const guard = createGuard();

    expect(
      guard.canActivate(contextWithHeaders({ referer: 'https://app.example.com/dashboard' })),
    ).toBe(true);
  });
});
