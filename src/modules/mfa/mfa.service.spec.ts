import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { authenticator } from 'otplib';
import * as argon2 from 'argon2';
import { MfaService } from './mfa.service';

jest.mock('argon2', () => ({
  argon2id: 2,
  hash: jest.fn(),
  verify: jest.fn(),
}));

describe('MfaService', () => {
  const userId = 'user-1';
  const key = Buffer.alloc(32, 1).toString('base64');
  let prisma: any;
  let stepUpService: any;
  let service: MfaService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = {
      userMfaTotpCredential: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
      },
      userMfaTotpRecoveryCode: {
        findMany: jest.fn(),
        update: jest.fn(),
        deleteMany: jest.fn(),
        createMany: jest.fn(),
      },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    prisma.userMfaTotpCredential.findUniqueOrThrow.mockResolvedValue({ id: 'cred-1', userId });
    stepUpService = { createProof: jest.fn().mockResolvedValue({ proofToken: 'proof', expiresAt: new Date('2026-06-05T00:00:00Z') }) };
    service = new MfaService(prisma, new ConfigService({ MFA_SECRET_ENCRYPTION_KEY: key }), stepUpService);
    jest.spyOn(authenticator, 'generateSecret').mockReturnValue('BASE32SECRET');
    jest.spyOn(authenticator, 'keyuri').mockReturnValue('otpauth://totp/SOFA%20ONE');
    jest.spyOn(authenticator, 'check').mockReturnValue(true);
    jest.mocked(argon2.hash).mockResolvedValue('hash' as never);
    jest.mocked(argon2.verify).mockResolvedValue(true as never);
  });

  it('creates pending setup secret', async () => {
    prisma.userMfaTotpCredential.findUnique.mockResolvedValue(null);

    const result = await service.setupTotp(userId, 'user@example.com');

    expect(result.secret).toBe('BASE32SECRET');
    expect(prisma.userMfaTotpCredential.upsert).toHaveBeenCalled();
  });

  it('enables TOTP and returns recovery codes', async () => {
    prisma.userMfaTotpCredential.findUnique.mockResolvedValue({ id: 'cred-1', userId, encryptedSecret: service['encrypt']('BASE32SECRET'), status: 'pending' });

    const result = await service.enableTotp(userId, '123456');

    expect(result.recoveryCodes).toHaveLength(10);
    expect(result.recoveryCodes).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/),
      ]),
    );
    expect(stepUpService.createProof).not.toHaveBeenCalled();
  });

  it('verifies TOTP and issues proof', async () => {
    prisma.userMfaTotpCredential.findUnique.mockResolvedValue({ id: 'cred-1', userId, encryptedSecret: service['encrypt']('BASE32SECRET'), status: 'enabled' });
    prisma.userMfaTotpRecoveryCode.findMany.mockResolvedValue([]);

    await service.verifyTotp(userId, '123456');

    expect(stepUpService.createProof).toHaveBeenCalledWith(userId, 'totp_mfa');
  });

  it.each([
    ['missing', null],
    ['pending', { id: 'cred-1', userId, encryptedSecret: 'unused', status: 'pending' }],
    ['disabled', { id: 'cred-1', userId, encryptedSecret: 'unused', status: 'disabled' }],
  ])('rejects verifyTotp when the credential is %s', async (_state, credential) => {
    prisma.userMfaTotpCredential.findUnique.mockResolvedValue(credential);

    await expect(service.verifyTotp(userId, '123456')).rejects.toThrow(NotFoundException);

    expect(stepUpService.createProof).not.toHaveBeenCalled();
    expect(prisma.userMfaTotpCredential.update).not.toHaveBeenCalled();
  });

  it('disables TOTP after verification without issuing a step-up proof', async () => {
    prisma.userMfaTotpCredential.findUnique.mockResolvedValue({ id: 'cred-1', userId, encryptedSecret: service['encrypt']('BASE32SECRET'), status: 'enabled' });

    await service.disableTotp(userId, '123456');

    expect(stepUpService.createProof).not.toHaveBeenCalled();
    expect(prisma.userMfaTotpRecoveryCode.deleteMany).toHaveBeenCalledWith({ where: { credentialId: 'cred-1' } });
    expect(prisma.userMfaTotpCredential.update).toHaveBeenCalledWith({
      where: { userId },
      data: { status: 'disabled', disabledAt: expect.any(Date) },
    });
  });

  it.each([
    ['missing', null],
    ['pending', { id: 'cred-1', userId, encryptedSecret: 'unused', status: 'pending' }],
    ['disabled', { id: 'cred-1', userId, encryptedSecret: 'unused', status: 'disabled' }],
  ])('rejects disableTotp when the credential is %s without closing it', async (_state, credential) => {
    prisma.userMfaTotpCredential.findUnique.mockResolvedValue(credential);

    await expect(service.disableTotp(userId, '123456')).rejects.toThrow(NotFoundException);

    expect(stepUpService.createProof).not.toHaveBeenCalled();
    expect(prisma.userMfaTotpCredential.update).not.toHaveBeenCalled();
    expect(prisma.userMfaTotpRecoveryCode.deleteMany).not.toHaveBeenCalled();
  });

  it('does not disable TOTP when the verification code is invalid', async () => {
    jest.spyOn(authenticator, 'check').mockReturnValue(false);
    prisma.userMfaTotpCredential.findUnique.mockResolvedValue({ id: 'cred-1', userId, encryptedSecret: service['encrypt']('BASE32SECRET'), status: 'enabled' });
    prisma.userMfaTotpRecoveryCode.findMany.mockResolvedValue([]);

    await expect(service.disableTotp(userId, '000000')).rejects.toThrow(BadRequestException);

    expect(prisma.userMfaTotpCredential.update).not.toHaveBeenCalled();
    expect(prisma.userMfaTotpRecoveryCode.deleteMany).not.toHaveBeenCalled();
    expect(stepUpService.createProof).not.toHaveBeenCalled();
  });

  it('disables TOTP with a recovery code and consumes it without issuing proof', async () => {
    jest.spyOn(authenticator, 'check').mockReturnValue(false);
    prisma.userMfaTotpCredential.findUnique.mockResolvedValue({ id: 'cred-1', userId, encryptedSecret: service['encrypt']('BASE32SECRET'), status: 'enabled' });
    prisma.userMfaTotpRecoveryCode.findMany.mockResolvedValue([{ id: 'code-1', codeHash: 'hash' }]);

    await service.disableTotp(userId, 'abcd-1234-wxyz');

    expect(prisma.userMfaTotpRecoveryCode.update).toHaveBeenCalledWith({
      where: { id: 'code-1' }, data: { usedAt: expect.any(Date) },
    });
    expect(stepUpService.createProof).not.toHaveBeenCalled();
    expect(prisma.userMfaTotpCredential.update).toHaveBeenCalled();
  });

  it('checks every unused recovery code and consumes the matching one', async () => {
    jest.spyOn(authenticator, 'check').mockReturnValue(false);
    prisma.userMfaTotpCredential.findUnique.mockResolvedValue({ id: 'cred-1', userId, encryptedSecret: service['encrypt']('BASE32SECRET'), status: 'enabled' });
    prisma.userMfaTotpRecoveryCode.findMany.mockResolvedValue([
      { id: 'code-1', codeHash: 'wrong-hash' },
      { id: 'code-2', codeHash: 'right-hash' },
    ]);
    jest.mocked(argon2.verify).mockResolvedValueOnce(false as never).mockResolvedValueOnce(true as never);

    await service.verifyTotp(userId, 'ABCD-1234-WXYZ');

    expect(argon2.verify).toHaveBeenCalledTimes(2);
    expect(prisma.userMfaTotpRecoveryCode.update).toHaveBeenCalledWith({
      where: { id: 'code-2' },
      data: { usedAt: expect.any(Date) },
    });
    expect(stepUpService.createProof).toHaveBeenCalledWith(userId, 'totp_mfa');
  });

  it('rejects already enabled setup', async () => {
    prisma.userMfaTotpCredential.findUnique.mockResolvedValue({ status: 'enabled' });

    await expect(service.setupTotp(userId)).rejects.toThrow(BadRequestException);
  });
});
