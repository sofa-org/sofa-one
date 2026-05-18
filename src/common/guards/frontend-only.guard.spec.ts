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

function createGuard({
  corsOrigin,
  isFrontendOnly = true,
}: {
  corsOrigin?: string | undefined;
  isFrontendOnly?: boolean;
} = { corsOrigin: 'https://app.example.com' }) {
  return new FrontendOnlyGuard(
    { getAllAndOverride: jest.fn().mockReturnValue(isFrontendOnly) } as unknown as Reflector,
    { get: jest.fn().mockReturnValue(corsOrigin) } as unknown as ConfigService,
  );
}

describe('FrontendOnlyGuard', () => {
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

  it('allows non-frontend-only routes without origin or referer', () => {
    const guard = createGuard({ isFrontendOnly: false });

    expect(guard.canActivate(contextWithHeaders({}))).toBe(true);
  });

  it('rejects missing origin and referer on frontend-only routes', () => {
    const guard = createGuard();

    expect(() => guard.canActivate(contextWithHeaders({}))).toThrow(ForbiddenException);
  });

  it('rejects invalid origin and referer strings', () => {
    const guard = createGuard();

    expect(() => guard.canActivate(contextWithHeaders({ origin: 'not-a-url' }))).toThrow(
      ForbiddenException,
    );
    expect(() => guard.canActivate(contextWithHeaders({ referer: 'also-not-a-url' }))).toThrow(
      ForbiddenException,
    );
  });

  it('defaults to localhost allowlist when CORS_ORIGIN is empty or undefined', () => {
    const emptyGuard = createGuard({ corsOrigin: '' });
    const undefinedGuard = createGuard({ corsOrigin: undefined });

    expect(emptyGuard.canActivate(contextWithHeaders({ origin: 'http://localhost:3000' }))).toBe(
      true,
    );
    expect(
      undefinedGuard.canActivate(contextWithHeaders({ referer: 'http://localhost:3100/page' })),
    ).toBe(true);
  });

  it('matches trimmed comma-separated configured origins exactly', () => {
    const guard = createGuard({ corsOrigin: ' https://app.example.com , http://localhost:3000 ' });

    expect(guard.canActivate(contextWithHeaders({ origin: 'http://localhost:3000' }))).toBe(true);
    expect(guard.canActivate(contextWithHeaders({ origin: 'https://app.example.com' }))).toBe(
      true,
    );
  });

  it('prefers origin over referer', () => {
    const guard = createGuard();

    expect(() =>
      guard.canActivate(
        contextWithHeaders({
          origin: 'https://evil.example.com',
          referer: 'https://app.example.com/dashboard',
        }),
      ),
    ).toThrow(ForbiddenException);
  });
});
