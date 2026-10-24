import {
  CanActivate, ExecutionContext, HttpException, Injectable,
  ServiceUnavailableException, UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AppSessionService } from '../../modules/app-session/app-session.service';
import { ALLOW_PENDING_MFA_KEY } from '../decorators/allow-pending-mfa.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { FrontendOnlyGuard } from './frontend-only.guard';

/** Dashboard authentication accepts only a live application cookie, never IAM or API keys. */
@Injectable()
export class AppSessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: AppSessionService,
    private readonly frontendOnly: FrontendOnlyGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.sessions.readToken(request);
    if (!token) throw new UnauthorizedException('Missing application session');

    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      this.frontendOnly.assertTrustedOrigin(request);
      this.sessions.assertCsrf(token, request.headers['x-csrf-token']);
    }
    try {
      const session = await this.sessions.authenticate(token);
      const pendingAllowed = this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_MFA_KEY, targets);
      this.sessions.assertLive(session, !pendingAllowed);
      request.user = session.user;
      request.appSession = session;
      return true;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Application session service unavailable');
    }
  }
}
