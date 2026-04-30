import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { OpenfortService } from '../../core/openfort/openfort.service';

/**
 * Verifies the Openfort IAM access token from Authorization: Bearer.
 * On success, attaches `openfortUserId` and `openfortSession` to the request.
 */
@Injectable()
export class OpenfortAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly openfort: OpenfortService,
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
