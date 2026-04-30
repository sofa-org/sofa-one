import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../core/database/prisma.service';
import { OpenfortService } from '../../core/openfort/openfort.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Openfort-only guard for dashboard/frontend routes. It never accepts API keys.
 */
@Injectable()
export class OpenfortUserGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly openfort: OpenfortService,
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
    if (!token) throw new UnauthorizedException('Missing authorization token');

    try {
      const session = await this.openfort.verifyIamSession(token);
      const user = await this.prisma.user.findUnique({
        where: { socialId: session.openfortUserId },
      });
      if (!user) throw new UnauthorizedException('User not found');

      request.user = user;
      request.openfortUserId = session.openfortUserId;
      request.openfortSession = session.session;
      request.openfortEmail = session.email;
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
