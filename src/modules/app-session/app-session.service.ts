import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppSession, Prisma, User } from '@prisma/client';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { Request, Response } from 'express';
import { PrismaService } from '../../core/database/prisma.service';
import { API_ERROR_CODES } from '../../common/errors/api-error-codes';

export const APP_SESSION_TTL_MS = 60 * 60 * 1000;
export const MFA_PENDING_TTL_MS = 15 * 60 * 1000;
export type AuthenticatedAppSession = AppSession & { user: User };
export interface AppSessionSnapshot {
  sessionId: string;
  userId: string;
  email: string | null;
  mfaVerified: boolean;
  expiresAt: string;
  csrfToken: string;
}

@Injectable()
export class AppSessionService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}

  get cookieName(): string {
    return this.isProduction ? '__Host-sofa_session' : 'sofa_session';
  }

  private get isProduction(): boolean {
    return this.config.get<string>('NODE_ENV') === 'production';
  }

  readToken(request: Pick<Request, 'headers'>): string | undefined {
    const values = request.headers.cookie?.split(';').map((part) => part.trim())
      .filter((part) => part.startsWith(`${this.cookieName}=`));
    if (!values || values.length !== 1) return undefined;
    const token = values[0].slice(this.cookieName.length + 1);
    return /^[a-f0-9]{64}$/.test(token) ? token : undefined;
  }

  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  csrfToken(token: string): string {
    return createHash('sha256').update(`csrf:${token}`).digest('hex');
  }

  assertCsrf(token: string, supplied: unknown): void {
    if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) ||
      !timingSafeEqual(Buffer.from(this.csrfToken(token), 'hex'), Buffer.from(supplied, 'hex'))) {
      throw new ForbiddenException('Invalid CSRF token');
    }
  }

  async authenticate(token: string): Promise<AuthenticatedAppSession> {
    const session = await this.prisma.appSession.findUnique({
      where: { tokenHash: this.hashToken(token) }, include: { user: true },
    });
    return this.assertLive(session);
  }

  assertLive(session: AuthenticatedAppSession | null, requireMfa = false): AuthenticatedAppSession {
    const now = Date.now();
    if (!session || session.revokedAt || session.expiresAt.getTime() <= now ||
      (!session.mfaVerified && session.mfaPendingUntil.getTime() <= now)) {
      throw new UnauthorizedException('Application session is missing or expired');
    }
    if (session.user.frozenAt) throw new ForbiddenException('User account is frozen');
    if (requireMfa && !session.mfaVerified) {
      throw new ForbiddenException({ code: API_ERROR_CODES.MFA_REQUIRED, message: 'MFA verification required' });
    }
    return session;
  }

  snapshot(session: AuthenticatedAppSession, token: string): AppSessionSnapshot {
    return {
      sessionId: session.id, userId: session.userId, email: session.user.email,
      mfaVerified: session.mfaVerified, expiresAt: session.expiresAt.toISOString(),
      csrfToken: this.csrfToken(token),
    };
  }

  async exchange(userId: string, previousToken: string | undefined) {
    const token = randomBytes(32).toString('hex');
    const session = await this.prisma.$transaction(async (tx) => {
      const previous = previousToken
        ? await tx.appSession.findUnique({ where: { tokenHash: this.hashToken(previousToken) } })
        : null;
      // A replacement cookie may belong to another user. Acquire both owners in
      // stable UUID order before any session write, avoiding cross-owner deadlocks.
      for (const id of [...new Set([userId, ...(previous ? [previous.userId] : [])])].sort()) {
        await this.lockUser(tx, id);
      }
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new UnauthorizedException('User not found');
      if (user.frozenAt) throw new ForbiddenException('User account is frozen');
      const now = new Date();
      if (previous) await this.revokeInTransaction(tx, { id: previous.id }, now);
      return tx.appSession.create({
        data: {
          userId, tokenHash: this.hashToken(token), mfaVerified: false, createdAt: now,
          expiresAt: new Date(now.getTime() + APP_SESSION_TTL_MS),
          mfaPendingUntil: new Date(now.getTime() + MFA_PENDING_TTL_MS),
        }, include: { user: true },
      });
    });
    return { token, session };
  }

  setCookie(response: Response, token: string, expiresAt: Date): void {
    response.cookie(this.cookieName, token, {
      httpOnly: true, secure: this.isProduction, sameSite: 'lax', path: '/', expires: expiresAt,
    });
    response.setHeader('Cache-Control', 'no-store');
  }

  clearCookie(response: Response): void {
    response.clearCookie(this.cookieName, {
      httpOnly: true, secure: this.isProduction, sameSite: 'lax', path: '/',
    });
    response.setHeader('Cache-Control', 'no-store');
  }

  // All MFA/session mutations lock user -> session. Logout-all and factor disable
  // serialize against exchanges and verifies, so a committed revoke cannot be undone.
  async lockUser(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
  }

  async lockSession(tx: Prisma.TransactionClient, userId: string, sessionId: string, requireMfa = false) {
    await this.lockUser(tx, userId);
    await tx.$queryRaw`SELECT id FROM app_sessions WHERE id = ${sessionId}::uuid AND user_id = ${userId}::uuid FOR UPDATE`;
    const session = await tx.appSession.findFirst({ where: { id: sessionId, userId }, include: { user: true } });
    return this.assertLive(session, requireMfa);
  }

  async revoke(userId: string, sessionId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockUser(tx, userId);
      await this.revokeInTransaction(tx, { id: sessionId, userId }, new Date());
    });
  }

  async revokeAll(userId: string, sessionId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockSession(tx, userId, sessionId, true);
      await this.revokeAllInTransaction(tx, userId);
    });
  }

  async revokeAllInTransaction(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    await this.revokeInTransaction(tx, { userId }, new Date());
  }

  private async revokeInTransaction(tx: Prisma.TransactionClient, where: Prisma.AppSessionWhereInput, now: Date) {
    // Acquire the session row locks before deleting proofs; concurrent verification
    // either commits first and gets deleted, or observes revocation and cannot issue.
    await tx.appSession.updateMany({ where: { ...where, revokedAt: null }, data: { revokedAt: now } });
    await tx.stepUpChallenge.deleteMany({ where: { session: where } });
  }
}
