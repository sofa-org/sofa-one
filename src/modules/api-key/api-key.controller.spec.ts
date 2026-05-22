import { GUARDS_METADATA } from '@nestjs/common/constants';

jest.mock('./api-key.service', () => ({
  ApiKeyService: class ApiKeyService {},
}));
jest.mock('../../common/guards/frontend-only.guard', () => ({
  FrontendOnlyGuard: class FrontendOnlyGuard {},
}));
jest.mock('../../common/guards/openfort-user.guard', () => ({
  OpenfortUserGuard: class OpenfortUserGuard {},
}));

import { ApiKeyController } from './api-key.controller';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';
import { OpenfortUserGuard } from '../../common/guards/openfort-user.guard';
import { IS_FRONTEND_ONLY_KEY } from '../../common/decorators/frontend-only.decorator';

describe('ApiKeyController', () => {
  const apiKeyService = {
    createApiKey: jest.fn(),
    listApiKeys: jest.fn(),
    revokeApiKey: jest.fn(),
    revokeAllKeys: jest.fn(),
  };

  let controller: ApiKeyController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new ApiKeyController(apiKeyService as any);
  });

  it('uses frontend-only guards at the class level', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, ApiKeyController) ?? [];

    expect(guards).toContain(FrontendOnlyGuard);
    expect(guards).toContain(OpenfortUserGuard);
    expect(Reflect.getMetadata(IS_FRONTEND_ONLY_KEY, ApiKeyController)).toBe(true);
  });

  it('delegates create to apiKeyService.createApiKey', async () => {
    apiKeyService.createApiKey.mockResolvedValue({ rawKey: 'sk_test' });

    await expect(controller.create('user-1', { name: 'My Key' } as any)).resolves.toEqual({
      rawKey: 'sk_test',
    });
    expect(apiKeyService.createApiKey).toHaveBeenCalledWith('user-1', {
      name: 'My Key',
      expiresAt: undefined,
      allowedIps: undefined,
      permissions: undefined,
    });
  });

  it('passes permissions to apiKeyService.createApiKey', async () => {
    apiKeyService.createApiKey.mockResolvedValue({ rawKey: 'sk_test' });

    await controller.create('user-1', {
      name: 'Signer',
      permissions: { canSign: true, canReadTransactionStatus: true },
    } as any);

    expect(apiKeyService.createApiKey).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        permissions: { canSign: true, canReadTransactionStatus: true },
      }),
    );
  });

  it('delegates list to apiKeyService.listApiKeys', async () => {
    apiKeyService.listApiKeys.mockResolvedValue([{ id: 'key-1' }]);

    await expect(controller.list('user-1')).resolves.toEqual([{ id: 'key-1' }]);
    expect(apiKeyService.listApiKeys).toHaveBeenCalledWith('user-1');
  });

  it('delegates revoke to apiKeyService.revokeApiKey', async () => {
    apiKeyService.revokeApiKey.mockResolvedValue(undefined);

    await expect(controller.revoke('user-1', 'key-1')).resolves.toEqual({ success: true });
    expect(apiKeyService.revokeApiKey).toHaveBeenCalledWith('key-1', 'user-1');
  });

  it('delegates revoke all to apiKeyService.revokeAllKeys', async () => {
    apiKeyService.revokeAllKeys.mockResolvedValue({ count: 3 });

    await expect(controller.revokeAll('user-1')).resolves.toEqual({
      success: true,
      revokedCount: 3,
    });
    expect(apiKeyService.revokeAllKeys).toHaveBeenCalledWith('user-1');
  });
});
