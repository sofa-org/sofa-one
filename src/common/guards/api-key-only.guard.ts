import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

/** Requires a successfully authenticated API key on routes that also use EitherAuthGuard. */
@Injectable()
export class ApiKeyOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ apiKeyRecord?: unknown }>();
    if (!request.apiKeyRecord) {
      throw new UnauthorizedException('API key is required for signing');
    }
    return true;
  }
}
