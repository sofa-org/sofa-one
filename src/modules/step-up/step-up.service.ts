import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import * as argon2 from 'argon2';
import { PrismaService } from '../../core/database/prisma.service';

/** Proof lifetime after verification: 15 minutes */
const PROOF_TTL_MS = 15 * 60 * 1000;

@Injectable()
export class StepUpService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Validate a step-up proof token.
   * Returns the user ID if valid, throws if invalid.
   */
  async validateProof(proofToken: string, userId: string, type: string = 'totp_mfa'): Promise<boolean> {
    const challenge = await this.prisma.stepUpChallenge.findFirst({
      where: {
        proofToken,
        type,
        verified: true,
        expiresAt: { gt: new Date() },
      },
    });

    if (!challenge) {
      return false;
    }

    if (challenge.userId !== userId) {
      return false;
    }

    return true;
  }

  async createProof(userId: string, type: string = 'totp_mfa'): Promise<{ proofToken: string; expiresAt: Date }> {
    const proofToken = randomBytes(32).toString('hex');
    const proofExpiresAt = new Date(Date.now() + PROOF_TTL_MS);

    await this.prisma.stepUpChallenge.create({
      data: {
        userId,
        type,
        challengeCodeHash: await argon2.hash(randomBytes(16).toString('hex'), {
          type: argon2.argon2id,
          memoryCost: 65536,
          timeCost: 3,
          parallelism: 1,
        }),
        proofToken,
        verified: true,
        attempts: 0,
        expiresAt: proofExpiresAt,
        verifiedAt: new Date(),
      },
    });

    return { proofToken, expiresAt: proofExpiresAt };
  }

  /**
   * Clean up expired challenges.
   * Should be called periodically (e.g., via cron job).
   */
  async cleanupExpiredChallenges(): Promise<number> {
    const result = await this.prisma.stepUpChallenge.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return result.count;
  }

}
