import { BadGatewayException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

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

  it.each([new UnauthorizedException('expired'), new BadGatewayException('upstream unavailable')])(
    'preserves the authentication failure status $status',
    async (error) => {
      const { guard, openfort } = createGuard();
      openfort.verifyIamSession.mockRejectedValue(error);
      await expect(
        guard.canActivate(contextWithHeaders({ authorization: 'Bearer token-123' })),
      ).rejects.toBe(error);
    },
  );
});
