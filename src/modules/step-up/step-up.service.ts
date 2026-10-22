import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../core/database/prisma.service';
import { AppSessionService } from '../app-session/app-session.service';

const PROOF_TTL_MS = 15 * 60 * 1000;

@Injectable()
export class StepUpService {
  constructor(private readonly prisma: PrismaService, private readonly sessions: AppSessionService) {}

  async validateProof(proofToken: string, userId: string, sessionId: string, type = 'totp_mfa'): Promise<boolean> {
    const now = new Date();
    const challenge = await this.prisma.stepUpChallenge.findFirst({
      where: {
        proofToken, userId, sessionId, type, verified: true, expiresAt: { gt: now },
        session: {
          userId, mfaVerified: true, revokedAt: null, expiresAt: { gt: now },
          user: { frozenAt: null },
        },
      },
    });
    return challenge !== null;
  }

  /** Called in the factor-verification transaction, never as an unbound proof issuer. */
  async createProof(tx: Prisma.TransactionClient, userId: string, sessionId: string, type = 'totp_mfa') {
    const session = await this.sessions.lockSession(tx, userId, sessionId, true);
    const now = new Date();
    const expiresAt = new Date(Math.min(now.getTime() + PROOF_TTL_MS, session.expiresAt.getTime()));
    const proofToken = randomBytes(32).toString('hex');
    await tx.stepUpChallenge.create({
      data: { userId, sessionId, type, proofToken, verified: true, expiresAt, verifiedAt: now },
    });
    return { proofToken, expiresAt };
  }

  async cleanupExpiredChallenges(): Promise<number> {
    const result = await this.prisma.stepUpChallenge.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    return result.count;
  }
}
