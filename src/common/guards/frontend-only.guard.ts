import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { IS_FRONTEND_ONLY_KEY } from '../decorators/frontend-only.decorator';

/**
 * Restricts access to routes marked with @FrontendOnly() to requests
 * originating from the configured CORS_ORIGIN allowlist.
 *
 * Checks the `Origin` header first, then falls back to `Referer`.
 * In development (no CORS_ORIGIN set), allows localhost:3000 and localhost:3100.
 */
@Injectable()
export class FrontendOnlyGuard implements CanActivate {
  private readonly allowedOrigins: string[];

  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
  ) {
    const corsOrigin = this.configService.get<string>('CORS_ORIGIN') ?? '';
    this.allowedOrigins = corsOrigin
      ? corsOrigin.split(',').map((o) => o.trim()).filter(Boolean)
      : ['http://localhost:3000', 'http://localhost:3100'];
  }

  canActivate(context: ExecutionContext): boolean {
    const isFrontendOnly = this.reflector.getAllAndOverride<boolean>(
      IS_FRONTEND_ONLY_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!isFrontendOnly) return true;

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
    }>();

    const origin = request.headers['origin'];
    const referer = request.headers['referer'];

    const candidate = origin ?? this.extractOriginFromReferer(referer);

    if (candidate && this.isAllowed(candidate)) {
      return true;
    }

    throw new ForbiddenException(
      'This endpoint is only accessible from the SOFA ONE frontend',
    );
  }

  private isAllowed(origin: string): boolean {
    return this.allowedOrigins.some((allowed) =>
      origin.startsWith(allowed),
    );
  }

  private extractOriginFromReferer(referer: string | undefined): string | undefined {
    if (!referer) return undefined;
    try {
      const url = new URL(referer);
      return url.origin;
    } catch {
      return undefined;
    }
  }
}
