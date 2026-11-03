import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import { PrismaService } from '../../core/database/prisma.service';
import { AppSessionService, AuthenticatedAppSession, APP_SESSION_TTL_MS, MFA_PENDING_TTL_MS } from './app-session.service';

const now = new Date('2026-10-22T12:00:00Z');
const rawToken = 'a'.repeat(64);
function liveSession(): AuthenticatedAppSession {
  return {
    id: 'session-1', userId: 'user-1', tokenHash: 'hash', mfaVerified: false,
    mfaPendingUntil: new Date(now.getTime() + MFA_PENDING_TTL_MS),
    expiresAt: new Date(now.getTime() + APP_SESSION_TTL_MS), revokedAt: null, createdAt: now,
    user: { id: 'user-1', socialProvider: 'openfort', socialId: 'provider-1', email: 'user@example.test', frozenAt: null, frozenReason: null, createdAt: now },
  };
}

function fixture(production = false) {
  const session = liveSession();
  const db = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    user: { findUnique: jest.fn(async () => session.user) },
    appSession: {
      findUnique: jest.fn(async () => session),
      findFirst: jest.fn(async () => session),
      create: jest.fn(async ({ data }: { data: Partial<AuthenticatedAppSession> }) => ({ ...session, ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    stepUpChallenge: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $transaction: jest.fn(async <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> => callback(db as unknown as Prisma.TransactionClient)),
  };
  // The in-memory delegate double implements only operations exercised by this service.
  const service = new AppSessionService(db as unknown as PrismaService, new ConfigService({ NODE_ENV: production ? 'production' : 'development' }));
  return { db, service, session };
}

describe('opaque application sessions', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => jest.useRealTimers());

  it('persists only a token hash and always creates a pending, fixed-lifetime login', async () => {
    const { service, db } = fixture();
    const first = await service.exchange('user-1', undefined);
    const second = await service.exchange('user-1', undefined);
    expect(first.token).toMatch(/^[a-f0-9]{64}$/);
    expect(first.token).not.toBe(second.token);
    expect(first.session.tokenHash).toBe(service.hashToken(first.token));
    expect(JSON.stringify(db.appSession.create.mock.calls)).not.toContain(first.token);
    expect(first.session).toMatchObject({ mfaVerified: false, createdAt: now,
      expiresAt: new Date(now.getTime() + APP_SESSION_TTL_MS), mfaPendingUntil: new Date(now.getTime() + MFA_PENDING_TTL_MS) });
    expect(service.snapshot(first.session, first.token)).toEqual({ sessionId: 'session-1', userId: 'user-1', email: 'user@example.test', mfaVerified: false,
      expiresAt: first.session.expiresAt.toISOString(), csrfToken: service.csrfToken(first.token) });
  });

  it('revokes the replaced cookie session and its proofs before issuing a new one', async () => {
    const { service, db } = fixture();
    await service.exchange('user-1', rawToken);
    expect(db.appSession.updateMany).toHaveBeenCalledWith({ where: { id: 'session-1', revokedAt: null }, data: { revokedAt: now } });
    expect(db.stepUpChallenge.deleteMany).toHaveBeenCalledWith({ where: { session: { id: 'session-1' } } });
    expect(db.stepUpChallenge.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(db.appSession.create.mock.invocationCallOrder[0]);
  });

  it('reads only the selected cookie and rejects ambiguous or malformed cookies', () => {
    const { service } = fixture();
    const request = (cookie?: string): Pick<Request, 'headers'> => ({ headers: { cookie } });
    expect(service.readToken(request(`other=secret; sofa_session=${rawToken}`))).toBe(rawToken);
    expect(service.readToken(request(`sofa_session=${rawToken}; sofa_session=${rawToken}`))).toBeUndefined();
    expect(service.readToken(request('sofa_session=%61'))).toBeUndefined();
    expect(service.readToken(request())).toBeUndefined();
    expect(fixture(true).service.readToken(request(`sofa_session=${rawToken}`))).toBeUndefined();
  });

  it('requires a constant-length session-derived CSRF token, not the cookie or another session token', () => {
    const { service } = fixture();
    expect(() => service.assertCsrf(rawToken, service.csrfToken(rawToken))).not.toThrow();
    for (const supplied of [undefined, '', rawToken, 'x'.repeat(64), service.csrfToken('b'.repeat(64)), [service.csrfToken(rawToken)]]) {
      expect(() => service.assertCsrf(rawToken, supplied)).toThrow(ForbiddenException);
    }
  });

  it('rejects pending logins exactly at their deadline, but full MFA keeps only the original one-hour deadline', async () => {
    const f = fixture();
    jest.setSystemTime(f.session.mfaPendingUntil);
    await expect(f.service.authenticate(rawToken)).rejects.toThrow(UnauthorizedException);
    f.session.mfaVerified = true;
    await expect(f.service.authenticate(rawToken)).resolves.toBe(f.session);
    jest.setSystemTime(f.session.expiresAt);
    await expect(f.service.authenticate(rawToken)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects revoked and frozen sessions without mutating identity', async () => {
    const f = fixture();
    f.session.revokedAt = now;
    await expect(f.service.authenticate(rawToken)).rejects.toThrow(UnauthorizedException);
    f.session.revokedAt = null;
    f.session.user.frozenAt = now;
    await expect(f.service.authenticate(rawToken)).rejects.toThrow(ForbiddenException);
    await expect(f.service.exchange('user-1', undefined)).rejects.toThrow(ForbiddenException);
    expect(f.db.appSession.create).not.toHaveBeenCalled();
  });

  it('marks pending business requests with stable MFA_REQUIRED and leaves pending introspection usable', () => {
    const { service, session } = fixture();
    expect(() => service.assertLive(session)).not.toThrow();
    try { service.assertLive(session, true); throw new Error('expected rejection'); }
    catch (error) {
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({ code: 'MFA_REQUIRED' });
    }
  });

  it.each([false, true])('sets host-only HttpOnly cookies with production=%s', (production) => {
    const { service, session } = fixture(production);
    const response = { cookie: jest.fn(), clearCookie: jest.fn(), setHeader: jest.fn() };
    // Express response methods are observed here without starting an HTTP server.
    const res = response as unknown as Response;
    service.setCookie(res, rawToken, session.expiresAt);
    expect(response.cookie).toHaveBeenCalledWith(production ? '__Host-sofa_session' : 'sofa_session', rawToken, {
      httpOnly: true, secure: production, sameSite: 'lax', path: '/', expires: session.expiresAt,
    });
    service.clearCookie(res);
    expect(response.clearCookie).toHaveBeenCalledWith(service.cookieName, { httpOnly: true, secure: production, sameSite: 'lax', path: '/' });
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  it('revokes all sessions and proofs only after rechecking the current full session', async () => {
    const f = fixture();
    await expect(f.service.revokeAll('user-1', 'session-1')).rejects.toThrow(ForbiddenException);
    expect(f.db.appSession.updateMany).not.toHaveBeenCalled();
    f.session.mfaVerified = true;
    await f.service.revokeAll('user-1', 'session-1');
    expect(f.db.appSession.updateMany).toHaveBeenCalledWith({ where: { userId: 'user-1', revokedAt: null }, data: { revokedAt: now } });
    expect(f.db.stepUpChallenge.deleteMany).toHaveBeenCalledWith({ where: { session: { userId: 'user-1' } } });
  });
});
