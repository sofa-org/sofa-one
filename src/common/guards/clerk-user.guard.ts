import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { verifyToken } from '@clerk/backend';
import { PrismaService } from '../../core/database/prisma.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Clerk-only guard for browser/frontend routes.
 *
 * Unlike EitherAuthGuard, this guard never accepts X-API-Key. It resolves the
 * local User row and attaches it to request.user so @CurrentUser() works.
 */
@Injectable()
export class ClerkUserGuard implements CanActivate {
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
    const token = this.extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException('Missing authorization token');
    }

    try {
      const parties = this.configService.get<string[]>('clerk.authorizedParties');
      const payload = await verifyToken(token, {
        secretKey: this.configService.getOrThrow<string>('clerk.secretKey'),
        ...(parties?.length ? { authorizedParties: parties } : {}),
      });

      const user = await this.prisma.user.findUnique({
        where: { socialId: payload.sub },
      });
      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      request.user = user;
      request.clerkUserId = payload.sub;
      request.clerkPayload = payload;
      return true;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Invalid authorization token');
    }
  }

  private extractBearerToken(request: { headers: Record<string, string> }): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
