import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { verifyToken } from '@clerk/backend';
import { createHash, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../core/database/prisma.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Accepts either Clerk JWT (Authorization: Bearer) or X-API-Key header.
 * In both cases, resolves the full user record and attaches it to request.user
 * so @CurrentUser() works uniformly.
 *
 * Priority: JWT first → API key fallback.
 */
@Injectable()
export class EitherAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();

    // 1. Try Clerk JWT
    const bearerToken = this.extractBearerToken(request);
    if (bearerToken) {
      return this.authenticateWithJwt(request, bearerToken);
    }

    // 2. Fall back to API key
    const apiKey = request.headers['x-api-key'] as string;
    if (apiKey) {
      return this.authenticateWithApiKey(request, apiKey);
    }

    throw new UnauthorizedException(
      'Missing authentication — provide Authorization Bearer token or X-API-Key header',
    );
  }

  private async authenticateWithJwt(
    request: any,
    token: string,
  ): Promise<boolean> {
    try {
      const payload = await verifyToken(token, {
        secretKey: this.configService.getOrThrow<string>('clerk.secretKey'),
      });

      const user = await this.prisma.user.findUnique({
        where: { socialId: payload.sub },
      });

      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      request.user = user;
      request.clerkUserId = payload.sub;
      return true;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Invalid authorization token');
    }
  }

  private async authenticateWithApiKey(
    request: any,
    apiKey: string,
  ): Promise<boolean> {
    const prefix = apiKey.substring(0, 11);

    const keyRecord = await this.prisma.apiKey.findFirst({
      where: {
        keyPrefix: prefix,
        revoked: false,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      include: { user: true },
    });

    if (!keyRecord) {
      throw new UnauthorizedException('Invalid API key');
    }

    // Verify SHA-256(salt + rawKey) matches stored hash
    const hash = createHash('sha256')
      .update(keyRecord.salt + apiKey)
      .digest('hex');

    const hashBuf = Buffer.from(hash);
    const storedBuf = Buffer.from(keyRecord.apiKeyHash);
    if (
      hashBuf.length !== storedBuf.length ||
      !timingSafeEqual(hashBuf, storedBuf)
    ) {
      throw new UnauthorizedException('Invalid API key');
    }

    // Optional IP whitelist enforcement
    if (keyRecord.allowedIps.length > 0) {
      const forwarded = request.headers['x-forwarded-for'] as string;
      const clientIp: string =
        forwarded?.split(',')[0]?.trim() ??
        request.ip ??
        request.connection?.remoteAddress;
      if (!keyRecord.allowedIps.includes(clientIp)) {
        throw new UnauthorizedException(
          'IP address not allowed for this API key',
        );
      }
    }

    request.user = keyRecord.user;
    request.apiKeyRecord = keyRecord;
    return true;
  }

  private extractBearerToken(request: {
    headers: Record<string, string>;
  }): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
