import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as argon2 from 'argon2';
import { PrismaService } from '../../core/database/prisma.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Validates the X-API-Key header against stored argon2id hashes.
 * On success, attaches `user` and `apiKeyRecord` to the request.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const apiKey = request.headers['x-api-key'] as string;

    if (!apiKey) {
      throw new UnauthorizedException('Missing X-API-Key header');
    }

    // Prefix = "sk_" + first 8 hex chars of secret (11 chars total)
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
}
