import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { verifyToken } from '@clerk/backend';
import * as argon2 from 'argon2';
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

    // Verify argon2id hash matches stored hash
    const isValid = await argon2.verify(keyRecord.apiKeyHash, apiKey);
    if (!isValid) {
      throw new UnauthorizedException('Invalid API key');
    }

    // Use request.ip which is correctly set by Express after trust-proxy processing.
    // Never read X-Forwarded-For directly — it can be forged by the client.
    if (keyRecord.allowedIps.length > 0) {
      const clientIp: string = request.ip ?? '';
      if (!keyRecord.allowedIps.includes(clientIp)) {
        throw new UnauthorizedException('IP address not allowed for this API key');
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
