import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import { randomBytes, randomInt, createCipheriv, createDecipheriv } from 'crypto';
import { PrismaService } from '../../core/database/prisma.service';
import { StepUpService } from '../step-up/step-up.service';
import { AppSessionService } from '../app-session/app-session.service';

const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly stepUpService: StepUpService,
    private readonly sessions: AppSessionService,
  ) {
    authenticator.options = { step: 30, window: 1 };
  }

  async getStatus(userId: string) {
    const credential = await this.prisma.userMfaTotpCredential.findUnique({
      where: { userId },
      include: { recoveryCodes: true },
    });
    return {
      enabled: credential?.status === 'enabled',
      recoveryCodesRemaining: credential?.recoveryCodes.filter((code) => !code.usedAt).length ?? 0,
    };
  }

  async setupTotp(userId: string, sessionId: string, email?: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const session = await this.sessions.lockSession(tx, userId, sessionId);
      const existing = await tx.userMfaTotpCredential.findUnique({ where: { userId } });
      if (existing?.status === 'enabled') throw new BadRequestException('MFA is already enabled');
      const secret = authenticator.generateSecret();
      const encryptedSecret = this.encrypt(secret);
      this.sessions.assertLive(session);
      await tx.userMfaTotpCredential.upsert({
        where: { userId },
        create: { userId, encryptedSecret, status: 'pending' },
        update: { encryptedSecret, status: 'pending', enabledAt: null, disabledAt: null },
      });
      return { secret, otpauthUrl: authenticator.keyuri(email ?? userId, 'SOFA ONE', secret) };
    });
  }

  async enableTotp(userId: string, sessionId: string, code: string) {
    return this.prisma.$transaction(async (tx) => {
      const session = await this.sessions.lockSession(tx, userId, sessionId);
      const credential = await tx.userMfaTotpCredential.findUnique({ where: { userId } });
      if (!credential) throw new NotFoundException('MFA credential not found');
      if (credential.status !== 'pending') throw new BadRequestException('MFA setup required');
      if (!authenticator.check(code, this.decrypt(credential.encryptedSecret))) {
        throw new BadRequestException('Invalid TOTP code');
      }
      const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => this.generateRecoveryCode());
      const hashes = await Promise.all(recoveryCodes.map(async (plainCode) => ({
        credentialId: credential.id, codeHash: await argon2.hash(plainCode, { type: argon2.argon2id }),
      })));
      this.sessions.assertLive(session);
      await tx.userMfaTotpCredential.update({
        where: { userId }, data: { status: 'enabled', enabledAt: new Date(), disabledAt: null },
      });
      await tx.userMfaTotpRecoveryCode.deleteMany({ where: { credentialId: credential.id } });
      await tx.userMfaTotpRecoveryCode.createMany({ data: hashes });
      return { recoveryCodes };
    });
  }

  async verifyTotp(userId: string, sessionId: string, code: string) {
    return this.prisma.$transaction(async (tx) => {
      const session = await this.sessions.lockSession(tx, userId, sessionId);
      await this.verifyFactor(tx, userId, code);
      // Recheck wall time after factor work; never upgrade an expired pending login.
      this.sessions.assertLive(session);
      await tx.appSession.update({ where: { id: sessionId }, data: { mfaVerified: true } });
      return this.stepUpService.createProof(tx, userId, sessionId, 'totp_mfa');
    });
  }

  private async verifyFactor(tx: Prisma.TransactionClient, userId: string, code: string) {
    const credential = await tx.userMfaTotpCredential.findUnique({ where: { userId } });
    if (!credential || credential.status !== 'enabled') throw new NotFoundException('MFA is not enabled');
    if (authenticator.check(code, this.decrypt(credential.encryptedSecret))) return;
    const recoveryCodes = await tx.userMfaTotpRecoveryCode.findMany({
      where: { credentialId: credential.id, usedAt: null },
    });
    for (const recovery of recoveryCodes) {
      if (await argon2.verify(recovery.codeHash, this.normalizeRecoveryCode(code))) {
        const consumed = await tx.userMfaTotpRecoveryCode.updateMany({
          where: { id: recovery.id, usedAt: null }, data: { usedAt: new Date() },
        });
        if (consumed.count === 1) return;
      }
    }
    throw new BadRequestException('Invalid TOTP or recovery code');
  }

  async disableTotp(userId: string, sessionId: string, code: string) {
    await this.prisma.$transaction(async (tx) => {
      const session = await this.sessions.lockSession(tx, userId, sessionId, true);
      await this.verifyFactor(tx, userId, code);
      this.sessions.assertLive(session, true);
      const credential = await tx.userMfaTotpCredential.findUniqueOrThrow({ where: { userId } });
      await tx.userMfaTotpRecoveryCode.deleteMany({ where: { credentialId: credential.id } });
      await tx.userMfaTotpCredential.update({
        where: { userId }, data: { status: 'disabled', disabledAt: new Date() },
      });
      await this.sessions.revokeAllInTransaction(tx, userId);
    });
  }

  private encrypt(value: string) {
    const key = this.getKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  }

  private decrypt(payload: string) {
    const raw = Buffer.from(payload, 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const encrypted = raw.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.getKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }

  private getKey() {
    const raw = this.config.get<string>('MFA_SECRET_ENCRYPTION_KEY');
    if (!raw) throw new BadRequestException('MFA secret encryption key missing');
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      throw new BadRequestException('MFA secret encryption key must be 32 base64-encoded bytes');
    }
    return key;
  }

  private generateRecoveryCode() {
    return Array.from({ length: 3 }, () => this.generateRecoveryCodeGroup()).join('-');
  }

  private generateRecoveryCodeGroup() {
    return Array.from({ length: 4 }, () => {
      const index = randomInt(RECOVERY_CODE_ALPHABET.length);
      return RECOVERY_CODE_ALPHABET[index];
    }).join('');
  }

  private normalizeRecoveryCode(code: string) {
    return code.trim().toUpperCase();
  }
}
