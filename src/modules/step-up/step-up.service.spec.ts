import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';
import { AppSessionService, AuthenticatedAppSession } from '../app-session/app-session.service';
import { StepUpService } from './step-up.service';

const now = new Date('2026-10-22T12:00:00Z');
function fixture() {
  const session: AuthenticatedAppSession = {
    id: 'session-1', userId: 'user-1', tokenHash: 'hash', mfaVerified: true,
    expiresAt: new Date(now.getTime() + 60 * 60_000), mfaPendingUntil: now, revokedAt: null, createdAt: now,
    user: { id: 'user-1', socialId: 'provider-1', socialProvider: 'openfort', email: null, frozenAt: null, frozenReason: null, createdAt: now },
  };
  const db = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    appSession: { findFirst: jest.fn().mockResolvedValue(session) },
    stepUpChallenge: { create: jest.fn(), findFirst: jest.fn().mockResolvedValue(null), deleteMany: jest.fn().mockResolvedValue({ count: 3 }) },
  };
  // These delegate doubles preserve the actual session-service checks and proof construction.
  const prisma = db as unknown as PrismaService;
  const sessions = new AppSessionService(prisma, new ConfigService());
  return { db, session, service: new StepUpService(prisma, sessions), tx: db as unknown as Prisma.TransactionClient };
}

describe('session-bound step-up proofs', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => jest.useRealTimers());

  it('caps a new proof at the remaining absolute session lifetime', async () => {
    const f = fixture();
    f.session.expiresAt = new Date(now.getTime() + 60_000);
    const result = await f.service.createProof(f.tx, 'user-1', 'session-1');
    expect(result.proofToken).toMatch(/^[a-f0-9]{64}$/);
    expect(result.expiresAt).toEqual(f.session.expiresAt);
  });

  it('never creates proofs for revoked, expired, or pending sessions', async () => {
    const f = fixture();
    f.session.revokedAt = now;
    await expect(f.service.createProof(f.tx, 'user-1', 'session-1')).rejects.toThrow(UnauthorizedException);
    f.session.revokedAt = null;
    f.session.expiresAt = now;
    await expect(f.service.createProof(f.tx, 'user-1', 'session-1')).rejects.toThrow(UnauthorizedException);
    f.session.expiresAt = new Date(now.getTime() + 60_000);
    f.session.mfaPendingUntil = new Date(now.getTime() + 30_000);
    f.session.mfaVerified = false;
    await expect(f.service.createProof(f.tx, 'user-1', 'session-1')).rejects.toThrow(ForbiddenException);
    expect(f.db.stepUpChallenge.create).not.toHaveBeenCalled();
  });

});
