import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes, randomInt } from 'crypto';
import * as argon2 from 'argon2';
import { PrismaService } from '../../core/database/prisma.service';

/** Challenge lifetime: 5 minutes */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Proof lifetime after verification: 15 minutes */
const PROOF_TTL_MS = 15 * 60 * 1000;
/** Max verification attempts per challenge */
const MAX_ATTEMPTS = 5;
/** Max challenges per user per hour */
const MAX_CHALLENGES_PER_HOUR = 5;

@Injectable()
export class StepUpService {
  private readonly logger = new Logger(StepUpService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a step-up challenge for the given user.
   * Generates a 6-digit OTP, hashes it, and stores the challenge.
   * Returns the challenge ID and the raw OTP (for delivery).
   *
   * In production, the OTP should be sent via email/SMS.
   * In development, it is logged for testing.
   */
  async createChallenge(
    userId: string,
    type: string = 'email_otp',
    recipientEmail?: string | null,
  ): Promise<{ challengeId: string; code: string }> {
    await this.assertChallengeRateLimit(userId);

    const email = await this.resolveRecipientEmail(userId, recipientEmail);
    const code = this.generateOtp();
    const codeHash = await argon2.hash(code, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });

    const challenge = await this.prisma.stepUpChallenge.create({
      data: {
        userId,
        type,
        challengeCodeHash: codeHash,
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
      },
    });

    this.logger.log(
      `Step-up challenge created: userId=${userId}, challengeId=${challenge.id}, type=${type}`,
    );

    try {
      await this.deliverOtp({
        userId,
        email,
        type,
        challengeId: challenge.id,
        code,
        expiresAt: challenge.expiresAt,
      });
    } catch (error) {
      await this.prisma.stepUpChallenge.deleteMany({ where: { id: challenge.id } });
      if (error instanceof BadGatewayException) throw error;
      throw new BadGatewayException('Unable to deliver step-up verification code');
    }

    return { challengeId: challenge.id, code };
  }

  /**
   * Verify a step-up challenge.
   * Checks the OTP against the stored hash, enforces attempt limits,
   * and issues a proof token on success.
   */
  async verifyChallenge(
    userId: string,
    challengeId: string,
    code: string,
  ): Promise<{ proofToken: string; expiresAt: Date }> {
    const challenge = await this.prisma.stepUpChallenge.findUnique({
      where: { id: challengeId },
    });

    if (!challenge) {
      throw new NotFoundException('Challenge not found');
    }

    if (challenge.userId !== userId) {
      throw new ForbiddenException('Challenge does not belong to this user');
    }

    if (challenge.verified) {
      throw new BadRequestException('Challenge already verified');
    }

    if (challenge.expiresAt < new Date()) {
      throw new BadRequestException('Challenge expired');
    }

    // Increment attempt counter
    const updated = await this.prisma.stepUpChallenge.update({
      where: { id: challengeId },
      data: { attempts: { increment: 1 } },
    });

    if (updated.attempts > MAX_ATTEMPTS) {
      throw new BadRequestException('Too many verification attempts');
    }

    // Verify OTP
    const codeMatches = await argon2.verify(challenge.challengeCodeHash, code);
    if (!codeMatches) {
      throw new BadRequestException('Invalid verification code');
    }

    // Issue proof token
    const proofToken = randomBytes(32).toString('hex');
    const proofExpiresAt = new Date(Date.now() + PROOF_TTL_MS);

    await this.prisma.stepUpChallenge.update({
      where: { id: challengeId },
      data: {
        verified: true,
        proofToken,
        verifiedAt: new Date(),
        expiresAt: proofExpiresAt, // Extend expiry to proof lifetime
      },
    });

    this.logger.log(
      `Step-up challenge verified: userId=${userId}, challengeId=${challengeId}`,
    );

    return { proofToken, expiresAt: proofExpiresAt };
  }

  /**
   * Validate a step-up proof token.
   * Returns the user ID if valid, throws if invalid.
   */
  async validateProof(proofToken: string, userId: string): Promise<boolean> {
    const challenge = await this.prisma.stepUpChallenge.findFirst({
      where: {
        proofToken,
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

  private generateOtp(): string {
    return String(randomInt(100000, 999999));
  }

  private async resolveRecipientEmail(userId: string, recipientEmail?: string | null) {
    const email = recipientEmail?.trim();
    if (email) return email;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (user?.email?.trim()) return user.email.trim();

    throw new BadRequestException('A verified email address is required for step-up verification');
  }

  private async deliverOtp(params: {
    userId: string;
    email: string;
    type: string;
    challengeId: string;
    code: string;
    expiresAt: Date;
  }) {
    if (process.env.NODE_ENV !== 'production') {
      this.logger.debug(`Step-up OTP for userId=${params.userId}: ${params.code}`);
      return;
    }

    const webhookUrl = process.env.STEP_UP_OTP_WEBHOOK_URL?.trim();
    if (!webhookUrl) {
      throw new BadGatewayException('Step-up OTP delivery is not configured');
    }

    let response: Response;
    try {
      response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'sofa-one-step-up/1.0',
          ...(process.env.STEP_UP_OTP_WEBHOOK_SECRET?.trim()
            ? { Authorization: `Bearer ${process.env.STEP_UP_OTP_WEBHOOK_SECRET.trim()}` }
            : {}),
        },
        body: JSON.stringify({
          type: 'step_up_otp',
          userId: params.userId,
          email: params.email,
          challengeId: params.challengeId,
          code: params.code,
          expiresAt: params.expiresAt.toISOString(),
        }),
      });
    } catch (error) {
      this.logger.error(
        `Step-up OTP webhook request failed: userId=${params.userId}, challengeId=${params.challengeId}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new BadGatewayException('Unable to deliver step-up verification code');
    }

    if (!response.ok) {
      this.logger.error(
        `Step-up OTP webhook returned ${response.status}: userId=${params.userId}, challengeId=${params.challengeId}`,
      );
      throw new BadGatewayException('Unable to deliver step-up verification code');
    }
  }

  private async assertChallengeRateLimit(userId: string): Promise<void> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentCount = await this.prisma.stepUpChallenge.count({
      where: {
        userId,
        createdAt: { gte: oneHourAgo },
      },
    });

    if (recentCount >= MAX_CHALLENGES_PER_HOUR) {
      throw new BadRequestException(
        'Too many step-up challenges requested. Please try again later.',
      );
    }
  }
}
