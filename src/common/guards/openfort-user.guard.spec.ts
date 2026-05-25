import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

jest.mock('../../core/openfort/openfort.service', () => ({
  OpenfortService: class OpenfortService {},
}));

import { OpenfortUserGuard } from './openfort-user.guard';

function contextWithHeaders(headers: Record<string, string | undefined>) {
  const request: any = { headers };

  return {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: () => ({ getRequest: () => request }),
    request,
  } as any;
}

function createGuard({ isPublic = false } = {}) {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(isPublic),
  } as unknown as Reflector;
  const openfort = {
    verifyIamSession: jest.fn(),
  } as any;
  const prisma = {
    user: {
      findUnique: jest.fn(),
    },
  } as any;

  return { guard: new OpenfortUserGuard(reflector, openfort, prisma), reflector, openfort, prisma };
}

describe('OpenfortUserGuard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects missing bearer tokens', async () => {
    const { guard, openfort } = createGuard();

    await expect(guard.canActivate(contextWithHeaders({}))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(openfort.verifyIamSession).not.toHaveBeenCalled();
  });

  it('rejects invalid bearer tokens', async () => {
    const { guard, openfort } = createGuard();
    openfort.verifyIamSession.mockRejectedValue(new Error('boom'));

    await expect(
      guard.canActivate(contextWithHeaders({ authorization: 'Bearer invalid-token' })),
    ).rejects.toThrow(UnauthorizedException);
    expect(openfort.verifyIamSession).toHaveBeenCalledWith('invalid-token');
  });

  it('does not accept API-key headers as authentication', async () => {
    const { guard, openfort } = createGuard();

    await expect(
      guard.canActivate(
        contextWithHeaders({ authorization: undefined, 'x-api-key': 'sk_test_123' }),
      ),
    ).rejects.toThrow(UnauthorizedException);
    expect(openfort.verifyIamSession).not.toHaveBeenCalled();
  });

  it('populates request user and Openfort session fields on success', async () => {
    const { guard, openfort, prisma } = createGuard();
    const request = {
      headers: { authorization: 'Bearer token-123' },
    } as any;
    const context = {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({ getRequest: () => request }),
    } as any;

    openfort.verifyIamSession.mockResolvedValue({
      openfortUserId: 'openfort-user-1',
      session: { id: 'session-1' },
      email: 'user@example.com',
    });
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', socialId: 'openfort-user-1' });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(openfort.verifyIamSession).toHaveBeenCalledWith('token-123');
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { socialId: 'openfort-user-1' },
    });
    expect(request.user).toEqual({ id: 'user-1', socialId: 'openfort-user-1' });
    expect(request.openfortUserId).toBe('openfort-user-1');
    expect(request.openfortSession).toEqual({ id: 'session-1' });
    expect(request.openfortEmail).toBe('user@example.com');
  });
});
