import { ForbiddenException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { Request } from 'express';
import { PrismaService } from '../../core/database/prisma.service';
import { AppSessionService, AuthenticatedAppSession } from '../../modules/app-session/app-session.service';
import { AllowPendingMfa } from '../decorators/allow-pending-mfa.decorator';
import { AppSessionGuard } from './app-session.guard';
import { FrontendOnlyGuard } from './frontend-only.guard';

class Dashboard {
  full() {}
  @AllowPendingMfa()
  pending() {}
}

const now = new Date('2026-10-22T12:00:00Z');
const rawToken = 'a'.repeat(64);
function fixture() {
  const session: AuthenticatedAppSession = {
    id: 'session-1', userId: 'user-1', tokenHash: 'hash', mfaVerified: true,
    mfaPendingUntil: new Date(now.getTime() + 15 * 60_000), expiresAt: new Date(now.getTime() + 60 * 60_000),
    revokedAt: null, createdAt: now,
    user: { id: 'user-1', socialId: 'provider-1', socialProvider: 'openfort', email: null, frozenAt: null, frozenReason: null, createdAt: now },
  };
  const db = { appSession: { findUnique: jest.fn().mockResolvedValue(session) } };
  const config = new ConfigService({ NODE_ENV: 'production', CORS_ORIGIN: 'https://app.example.test' });
  // Only the session lookup delegate is needed to exercise the real service and guard.
  const sessions = new AppSessionService(db as unknown as PrismaService, config);
  const reflector = new Reflector();
  const guard = new AppSessionGuard(reflector, sessions, new FrontendOnlyGuard(reflector, config));
  function request(headers: Record<string, string | string[] | undefined> = {}, method = 'GET', pending = false) {
    // A request-shaped double is sufficient: guards only read method/headers and attach auth.
    const req = { method, headers } as unknown as Request;
    return { req, context: new ExecutionContextHost([req], Dashboard, pending ? Dashboard.prototype.pending : Dashboard.prototype.full) };
  }
  return { session, db, sessions, guard, request };
}

describe('AppSessionGuard', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => jest.useRealTimers());

  it.each([{}, { authorization: 'Bearer provider-token' }, { 'x-api-key': 'sk_test' }])('does not accept bearer/API-key substitutes: %j', async (headers) => {
    const f = fixture();
    await expect(f.guard.canActivate(f.request(headers).context)).rejects.toThrow(UnauthorizedException);
    expect(f.db.appSession.findUnique).not.toHaveBeenCalled();
  });

  it('authenticates locally even with an unrelated IAM header and attaches no provider context', async () => {
    const f = fixture();
    const { req, context } = f.request({ cookie: `sofa_session=ignored; __Host-sofa_session=${rawToken}`, authorization: 'Bearer unrelated' });
    await expect(f.guard.canActivate(context)).resolves.toBe(true);
    expect(req.user).toBe(f.session.user);
    expect(req.appSession?.id).toBe('session-1');
    expect(req.openfortUserId).toBeUndefined();
    expect(req.openfortSession).toBeUndefined();
  });

  it('allows pending sessions only on explicit bootstrap handlers', async () => {
    const f = fixture();
    f.session.mfaVerified = false;
    await expect(f.guard.canActivate(f.request({ cookie: `__Host-sofa_session=${rawToken}` }).context)).rejects.toMatchObject({
      response: { code: 'MFA_REQUIRED' },
    });
    await expect(f.guard.canActivate(f.request({ cookie: `__Host-sofa_session=${rawToken}` }, 'GET', true).context)).resolves.toBe(true);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('requires CSRF and an explicit trusted Origin for %s regardless route metadata', async (method) => {
    const f = fixture();
    const cookie = `__Host-sofa_session=${rawToken}`;
    const csrf = f.sessions.csrfToken(rawToken);
    for (const headers of [
      { cookie }, { cookie, origin: 'https://app.example.test' },
      { cookie, 'x-csrf-token': csrf, referer: 'https://app.example.test/dashboard' },
      { cookie, 'x-csrf-token': csrf, origin: 'https://evil.example.test' },
      { cookie, 'x-csrf-token': [csrf], origin: 'https://app.example.test' },
    ]) {
      await expect(f.guard.canActivate(f.request(headers, method, true).context)).rejects.toThrow(ForbiddenException);
    }
    await expect(f.guard.canActivate(f.request({ cookie, 'x-csrf-token': csrf, origin: 'https://app.example.test' }, method, true).context)).resolves.toBe(true);
  });

  it('rejects missing, revoked, expired, and frozen sessions with distinct auth statuses', async () => {
    const f = fixture();
    const context = f.request({ cookie: `__Host-sofa_session=${rawToken}` }).context;
    f.db.appSession.findUnique.mockResolvedValueOnce(null);
    await expect(f.guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    f.session.revokedAt = now;
    await expect(f.guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    f.session.revokedAt = null;
    f.session.expiresAt = now;
    await expect(f.guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    f.session.expiresAt = new Date(now.getTime() + 60_000);
    f.session.user.frozenAt = now;
    await expect(f.guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('does not turn a database outage into a signed-out response', async () => {
    const f = fixture();
    f.db.appSession.findUnique.mockRejectedValue(new Error('database unavailable'));
    await expect(f.guard.canActivate(f.request({ cookie: `__Host-sofa_session=${rawToken}` }).context)).rejects.toThrow(ServiceUnavailableException);
  });
});
