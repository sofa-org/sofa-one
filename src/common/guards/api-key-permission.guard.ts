import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  API_KEY_PERMISSION_KEY,
  type ApiKeyPermission,
} from '../decorators/api-key-permission.decorator';

@Injectable()
export class ApiKeyPermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const permission = this.reflector.getAllAndOverride<ApiKeyPermission>(API_KEY_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!permission) return true;

    const request = context.switchToHttp().getRequest();
    const apiKeyRecord = request.apiKeyRecord as Record<string, unknown> | undefined;

    if (!apiKeyRecord) {
      throw new ForbiddenException('API key authentication is required');
    }

    if (apiKeyRecord[permission] !== true) {
      throw new ForbiddenException(`API key is missing required permission: ${permission}`);
    }

    return true;
  }
}
