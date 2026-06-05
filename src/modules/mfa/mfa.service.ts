import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import { randomBytes, randomInt, createCipheriv, createDecipheriv } from 'crypto';
import { PrismaService } from '../../core/database/prisma.service';
import { StepUpService } from '../step-up/step-up.service';

const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly stepUpService: StepUpService,
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

  async setupTotp(userId: string, email?: string | null) {
    const existing = await this.prisma.userMfaTotpCredential.findUnique({ where: { userId } });
    if (existing?.status === 'enabled') throw new BadRequestException('MFA is already enabled');

    const secret = authenticator.generateSecret();
    await this.prisma.userMfaTotpCredential.upsert({
      where: { userId },
      create: { userId, encryptedSecret: this.encrypt(secret), status: 'pending' },
      update: {
        encryptedSecret: this.encrypt(secret),
        status: 'pending',
        enabledAt: null,
        disabledAt: null,
      },
    });

    return {
      secret,
      otpauthUrl: authenticator.keyuri(email ?? userId, 'SOFA ONE', secret),
    };
  }

  async enableTotp(userId: string, code: string) {
    const credential = await this.getActiveOrPendingCredential(userId);
    const secret = this.decrypt(credential.encryptedSecret);
    if (!authenticator.check(code, secret)) throw new BadRequestException('Invalid TOTP code');

    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => this.generateRecoveryCode());
    await this.prisma.$transaction(async (tx) => {
      await tx.userMfaTotpCredential.update({
        where: { userId },
        data: { status: 'enabled', enabledAt: new Date(), disabledAt: null },
      });
      await tx.userMfaTotpRecoveryCode.deleteMany({ where: { credentialId: credential.id } });
      await tx.userMfaTotpRecoveryCode.createMany({
        data: await Promise.all(
          recoveryCodes.map(async (plainCode) => ({
            credentialId: credential.id,
            codeHash: await argon2.hash(plainCode, { type: argon2.argon2id }),
          })),
        ),
      });
    });

    return { recoveryCodes };
  }

  async verifyTotp(userId: string, code: string) {
    const credential = await this.getEnabledCredential(userId);
    const secret = this.decrypt(credential.encryptedSecret);
    if (authenticator.check(code, secret)) return this.issueProof(userId);

    const recoveryCodes = await this.prisma.userMfaTotpRecoveryCode.findMany({
      where: { credentialId: credential.id, usedAt: null },
    });

    for (const recovery of recoveryCodes) {
      if (await argon2.verify(recovery.codeHash, this.normalizeRecoveryCode(code))) {
        await this.prisma.userMfaTotpRecoveryCode.update({
          where: { id: recovery.id },
          data: { usedAt: new Date() },
        });
        return this.issueProof(userId);
      }
    }

    throw new BadRequestException('Invalid TOTP or recovery code');
  }

  async disableTotp(userId: string, code: string) {
    await this.verifyTotp(userId, code);
    await this.prisma.$transaction(async (tx) => {
      const credential = await tx.userMfaTotpCredential.findUniqueOrThrow({ where: { userId } });
      await tx.userMfaTotpRecoveryCode.deleteMany({ where: { credentialId: credential.id } });
      await tx.userMfaTotpCredential.update({
        where: { userId },
        data: { status: 'disabled', disabledAt: new Date() },
      });
    });
  }

  private async issueProof(userId: string) {
    return this.stepUpService.createProof(userId, 'totp_mfa');
  }

  private async getEnabledCredential(userId: string) {
    const credential = await this.prisma.userMfaTotpCredential.findUnique({ where: { userId } });
    if (!credential || credential.status !== 'enabled') throw new NotFoundException('MFA is not enabled');
    return credential;
  }

  private async getActiveOrPendingCredential(userId: string) {
    const credential = await this.prisma.userMfaTotpCredential.findUnique({ where: { userId } });
    if (!credential) throw new NotFoundException('MFA credential not found');
    return credential;
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
