import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { authenticator } from 'otplib';
import * as argon2 from 'argon2';
import { PrismaService } from '../../core/database/prisma.service';
import { AppSessionService, AuthenticatedAppSession } from '../app-session/app-session.service';
import { StepUpService } from '../step-up/step-up.service';
import { MfaService } from './mfa.service';

jest.mock('argon2', () => ({ argon2id: 2, hash: jest.fn(), verify: jest.fn() }));

const now = new Date('2026-10-22T12:00:00Z');
function fixture() {
  const session: AuthenticatedAppSession = {
    id: 'session-1', userId: 'user-1', tokenHash: 'hash', mfaVerified: false,
    expiresAt: new Date(now.getTime() + 60 * 60_000), mfaPendingUntil: new Date(now.getTime() + 15 * 60_000),
    revokedAt: null, createdAt: now,
    user: { id: 'user-1', socialId: 'provider-1', socialProvider: 'openfort', email: null, frozenAt: null, frozenReason: null, createdAt: now },
  };
  const db = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    appSession: {
      findFirst: jest.fn().mockResolvedValue(session),
      update: jest.fn(async () => { session.mfaVerified = true; return session; }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    userMfaTotpCredential: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'cred-1' }), upsert: jest.fn(), update: jest.fn() },
    userMfaTotpRecoveryCode: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn().mockResolvedValue({ count: 1 }), deleteMany: jest.fn(), createMany: jest.fn() },
    stepUpChallenge: { create: jest.fn(), deleteMany: jest.fn() },
    $transaction: jest.fn(async <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> => callback(db as unknown as Prisma.TransactionClient)),
  };
  const config = new ConfigService({ MFA_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') });
  // Partial delegates let the real session and step-up services enforce auth boundaries.
  const prisma = db as unknown as PrismaService;
  const sessions = new AppSessionService(prisma, config);
  const service = new MfaService(prisma, config, new StepUpService(prisma, sessions), sessions);
  const credential = { id: 'cred-1', userId: 'user-1', encryptedSecret: service['encrypt']('BASE32SECRET'), status: 'enabled' };
  db.userMfaTotpCredential.findUnique.mockResolvedValue(credential);
  return { service, db, session, credential };
}

describe('MFA session upgrade and recovery factors', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    jest.spyOn(authenticator, 'check').mockReturnValue(true);
    jest.spyOn(authenticator, 'generateSecret').mockReturnValue('BASE32SECRET');
    jest.spyOn(authenticator, 'keyuri').mockReturnValue('otpauth://totp/SOFA');
    jest.mocked(argon2.hash).mockResolvedValue('hash' as never);
    jest.mocked(argon2.verify).mockResolvedValue(true as never);
  });
  afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); jest.useRealTimers(); });

  it('creates pending factor setup without granting dashboard access', async () => {
    const f = fixture();
    f.db.userMfaTotpCredential.findUnique.mockResolvedValue(null);
    expect(await f.service.setupTotp('user-1', 'session-1', 'user@example.test')).toEqual({ secret: 'BASE32SECRET', otpauthUrl: 'otpauth://totp/SOFA' });
    expect(f.db.userMfaTotpCredential.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ status: 'pending' }) }));
    expect(f.session.mfaVerified).toBe(false);
  });

  it('enables a pending factor and returns recovery codes without upgrading the session', async () => {
    const f = fixture();
    f.credential.status = 'pending';
    const result = await f.service.enableTotp('user-1', 'session-1', '123456');
    expect(result.recoveryCodes).toHaveLength(10);
    expect(new Set(result.recoveryCodes).size).toBe(10);
    expect(result.recoveryCodes.every((code) => /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(code))).toBe(true);
    expect(f.session.mfaVerified).toBe(false);
    expect(f.db.stepUpChallenge.create).not.toHaveBeenCalled();
  });

  it('verifies the existing factor, upgrades only the bound session, and does not extend its lifetime', async () => {
    const f = fixture();
    const expiresAt = f.session.expiresAt;
    const proof = await f.service.verifyTotp('user-1', 'session-1', '123456');
    expect(f.session.mfaVerified).toBe(true);
    expect(f.session.expiresAt).toBe(expiresAt);
    expect(f.db.appSession.update).toHaveBeenCalledWith({ where: { id: 'session-1' }, data: { mfaVerified: true } });
    expect(f.db.stepUpChallenge.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: 'user-1', sessionId: 'session-1', proofToken: proof.proofToken }) });
  });

  it.each(['pending', 'disabled', 'missing'])('does not upgrade a %s factor', async (status) => {
    const f = fixture();
    if (status === 'missing') f.db.userMfaTotpCredential.findUnique.mockResolvedValue(null);
    else f.credential.status = status;
    await expect(f.service.verifyTotp('user-1', 'session-1', '123456')).rejects.toThrow(NotFoundException);
    expect(f.session.mfaVerified).toBe(false);
    expect(f.db.stepUpChallenge.create).not.toHaveBeenCalled();
  });

  it('does not upgrade if factor work crosses the pending deadline', async () => {
    const f = fixture();
    jest.spyOn(authenticator, 'check').mockImplementation(() => { jest.setSystemTime(f.session.mfaPendingUntil); return true; });
    await expect(f.service.verifyTotp('user-1', 'session-1', '123456')).rejects.toThrow(UnauthorizedException);
    expect(f.session.mfaVerified).toBe(false);
    expect(f.db.stepUpChallenge.create).not.toHaveBeenCalled();
  });

  it('consumes a matching recovery code using compare-and-set before upgrading', async () => {
    const f = fixture();
    jest.spyOn(authenticator, 'check').mockReturnValue(false);
    f.db.userMfaTotpRecoveryCode.findMany.mockResolvedValue([{ id: 'code-1', codeHash: 'wrong' }, { id: 'code-2', codeHash: 'right' }]);
    jest.mocked(argon2.verify).mockResolvedValueOnce(false as never).mockResolvedValueOnce(true as never);
    await f.service.verifyTotp('user-1', 'session-1', 'abcd-1234-wxyz');
    expect(f.db.userMfaTotpRecoveryCode.updateMany).toHaveBeenCalledWith({ where: { id: 'code-2', usedAt: null }, data: { usedAt: now } });
    expect(argon2.verify).toHaveBeenLastCalledWith('right', 'ABCD-1234-WXYZ');
    expect(f.session.mfaVerified).toBe(true);
  });

  it('denies a recovery code lost to a concurrent consumer', async () => {
    const f = fixture();
    jest.spyOn(authenticator, 'check').mockReturnValue(false);
    f.db.userMfaTotpRecoveryCode.findMany.mockResolvedValue([{ id: 'code-1', codeHash: 'hash' }]);
    f.db.userMfaTotpRecoveryCode.updateMany.mockResolvedValue({ count: 0 });
    await expect(f.service.verifyTotp('user-1', 'session-1', 'ABCD-1234-WXYZ')).rejects.toThrow(BadRequestException);
    expect(f.session.mfaVerified).toBe(false);
    expect(f.db.stepUpChallenge.create).not.toHaveBeenCalled();
  });

  it('factor disable requires full MFA and revokes every session/proof after verifying the code', async () => {
    const f = fixture();
    await expect(f.service.disableTotp('user-1', 'session-1', '123456')).rejects.toThrow('MFA verification required');
    f.session.mfaVerified = true;
    await f.service.disableTotp('user-1', 'session-1', '123456');
    expect(f.db.userMfaTotpCredential.update).toHaveBeenCalledWith({ where: { userId: 'user-1' }, data: { status: 'disabled', disabledAt: now } });
    expect(f.db.appSession.updateMany).toHaveBeenCalledWith({ where: { userId: 'user-1', revokedAt: null }, data: { revokedAt: now } });
    expect(f.db.stepUpChallenge.deleteMany).toHaveBeenCalled();
    expect(f.db.stepUpChallenge.create).not.toHaveBeenCalled();
  });

  it('does not disable or revoke anything for an invalid factor', async () => {
    const f = fixture();
    f.session.mfaVerified = true;
    jest.spyOn(authenticator, 'check').mockReturnValue(false);
    await expect(f.service.disableTotp('user-1', 'session-1', '000000')).rejects.toThrow(BadRequestException);
    expect(f.db.userMfaTotpCredential.update).not.toHaveBeenCalled();
    expect(f.db.appSession.updateMany).not.toHaveBeenCalled();
  });

  it('cannot reset an existing enabled factor through setup or enable', async () => {
    const f = fixture();
    await expect(f.service.setupTotp('user-1', 'session-1')).rejects.toThrow(BadRequestException);
    await expect(f.service.enableTotp('user-1', 'session-1', '123456')).rejects.toThrow(BadRequestException);
    expect(f.db.userMfaTotpRecoveryCode.createMany).not.toHaveBeenCalled();
  });
});
