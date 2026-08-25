import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeyPermissionGuard } from './api-key-permission.guard';

function contextWithApiKeyRecord(apiKeyRecord?: Record<string, unknown>) {
  return {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: () => ({
      getRequest: () => ({ apiKeyRecord }),
    }),
  } as any;
}

describe('ApiKeyPermissionGuard', () => {
  it('allows routes without required permission metadata', () => {
    const guard = new ApiKeyPermissionGuard({
      getAllAndOverride: jest.fn().mockReturnValue(undefined),
    } as unknown as Reflector);

    expect(guard.canActivate(contextWithApiKeyRecord())).toBe(true);
  });

  it('rejects permission-protected routes without an authenticated API key record', () => {
    const guard = new ApiKeyPermissionGuard({
      getAllAndOverride: jest.fn().mockReturnValue('canSign'),
    } as unknown as Reflector);

    expect(() => guard.canActivate(contextWithApiKeyRecord())).toThrow(ForbiddenException);
  });

  it('rejects API keys that do not have the required permission', () => {
    const guard = new ApiKeyPermissionGuard({
      getAllAndOverride: jest.fn().mockReturnValue('canSendTransaction'),
    } as unknown as Reflector);

    expect(() =>
      guard.canActivate(contextWithApiKeyRecord({ canSendTransaction: false })),
    ).toThrow(ForbiddenException);
  });

  it('allows API keys that have the required permission', () => {
    const guard = new ApiKeyPermissionGuard({
      getAllAndOverride: jest.fn().mockReturnValue('canReadTransactionStatus'),
    } as unknown as Reflector);

    expect(
      guard.canActivate(contextWithApiKeyRecord({ canReadTransactionStatus: true })),
    ).toBe(true);
  });
});
