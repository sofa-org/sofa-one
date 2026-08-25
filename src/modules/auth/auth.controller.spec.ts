import { GUARDS_METADATA } from '@nestjs/common/constants';

jest.mock('./auth.service', () => ({
  AuthService: class AuthService {},
}));

jest.mock('../../common/guards/openfort-auth.guard', () => ({
  OpenfortAuthGuard: class OpenfortAuthGuard {},
}));

jest.mock('../../common/guards/frontend-only.guard', () => ({
  FrontendOnlyGuard: class FrontendOnlyGuard {},
}));

jest.mock('../../common/guards/openfort-user.guard', () => ({
  OpenfortUserGuard: class OpenfortUserGuard {},
}));

jest.mock('../../common/guards/step-up.guard', () => ({
  StepUpGuard: class StepUpGuard {},
}));

import { AuthController } from './auth.controller';
import { OpenfortAuthGuard } from '../../common/guards/openfort-auth.guard';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';
import { OpenfortUserGuard } from '../../common/guards/openfort-user.guard';
import { StepUpGuard } from '../../common/guards/step-up.guard';
import { IS_FRONTEND_ONLY_KEY } from '../../common/decorators/frontend-only.decorator';
import { STEP_UP_KEY } from '../../common/decorators/step-up.decorator';

describe('AuthController', () => {
  const authService = {
    refreshApiKey: jest.fn(),
    authorizeEmbeddedWallet: jest.fn(),
  };

  let controller: AuthController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new AuthController(authService as any);
  });

  it('passes request access token through to authorizeEmbeddedWallet', async () => {
    const req = { openfortUserId: 'user-1', openfortAccessToken: 'token-1' };
    const body = { embeddedWalletAddress: '0x1111111111111111111111111111111111111111' };
    authService.authorizeEmbeddedWallet.mockResolvedValue({ ok: true });

    await controller.authorizeEmbeddedWallet(req as any, body as any);

    expect(authService.authorizeEmbeddedWallet).toHaveBeenCalledWith('user-1', 'token-1', body);
  });

  it('uses OpenfortAuthGuard at the controller level', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AuthController) ?? [];

    expect(guards).toContain(OpenfortAuthGuard);
  });

  it('uses frontend-only guard on refreshApiKey', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, controller.refreshApiKey) ?? [];

    expect(guards).toContain(OpenfortUserGuard);
    expect(guards).toContain(StepUpGuard);
    expect(guards).toContain(FrontendOnlyGuard);
    expect(Reflect.getMetadata(IS_FRONTEND_ONLY_KEY, controller.refreshApiKey)).toBe(true);
    expect(Reflect.getMetadata(STEP_UP_KEY, controller.refreshApiKey)).toBe(true);
  });

  it.each([
    'syncSession',
    'socialLogin',
    'authorizeEmbeddedWallet',
    'markAgentRegistrationTransaction',
    'markAgentRegistrationResult',
    'getMe',
  ] as const)('keeps %s outside frontend-only access boundary', (handlerName) => {
    const handler = controller[handlerName];
    const guards = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];

    expect(Reflect.getMetadata(IS_FRONTEND_ONLY_KEY, handler)).toBeUndefined();
    expect(guards).not.toContain(FrontendOnlyGuard);
  });
});
