import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

jest.mock('../../core/openfort/openfort.service', () => ({
  OpenfortService: class OpenfortService {},
}));

import { OpenfortAuthGuard } from './openfort-auth.guard';

function contextWithHeaders(headers: Record<string, string | undefined>) {
  return {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as any;
}

function createGuard({
  isPublic = false,
  verifyIamSession = jest.fn(),
}: {
  isPublic?: boolean;
  verifyIamSession?: jest.Mock;
} = {}) {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(isPublic),
  } as unknown as Reflector;
  const openfort = { verifyIamSession } as any;

  return { guard: new OpenfortAuthGuard(reflector, openfort), reflector, openfort };
}

describe('OpenfortAuthGuard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('bypasses public routes without verifying Openfort session', async () => {
    const { guard, openfort } = createGuard({ isPublic: true });

    await expect(guard.canActivate(contextWithHeaders({}))).resolves.toBe(true);
    expect(openfort.verifyIamSession).not.toHaveBeenCalled();
  });

  it('rejects missing or invalid authorization headers without calling Openfort', async () => {
    const { guard, openfort } = createGuard();

    await expect(guard.canActivate(contextWithHeaders({}))).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(
      guard.canActivate(contextWithHeaders({ authorization: 'Basic token' })),
    ).rejects.toThrow(UnauthorizedException);
    expect(openfort.verifyIamSession).not.toHaveBeenCalled();
  });

  it('rejects Openfort verification failures as unauthorized', async () => {
    const { guard, openfort } = createGuard();
    openfort.verifyIamSession.mockRejectedValue(new Error('boom'));

    await expect(
      guard.canActivate(contextWithHeaders({ authorization: 'Bearer token-123' })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('attaches Openfort session data on successful bearer token verification', async () => {
    const { guard, openfort } = createGuard();
    const session = {
      openfortUserId: 'user-1',
      session: { id: 'session-1' },
      email: 'user@example.com',
    };
    openfort.verifyIamSession.mockResolvedValue(session);
    const request = { headers: { authorization: 'Bearer token-123' } } as any;
    const context = {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({ getRequest: () => request }),
    } as any;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(openfort.verifyIamSession).toHaveBeenCalledWith('token-123');
    expect(request.openfortUserId).toBe('user-1');
    expect(request.openfortAccessToken).toBe('token-123');
    expect(request.openfortSession).toEqual({ id: 'session-1' });
    expect(request.openfortEmail).toBe('user@example.com');
  });
});
