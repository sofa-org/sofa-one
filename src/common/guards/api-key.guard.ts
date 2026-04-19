import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../core/database/prisma.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Validates the X-API-Key header against stored SHA-256 hashes.
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
        throw new UnauthorizedException('IP address not allowed for this API key');
      }
    }

    request.user = keyRecord.user;
    request.apiKeyRecord = keyRecord;
    return true;
  }
}
