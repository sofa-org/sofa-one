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

import { ApiKeyController, DefiCapabilityBundleController, DefiCapabilityController } from './api-key.controller';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';
import { OpenfortUserGuard } from '../../common/guards/openfort-user.guard';
import { IS_FRONTEND_ONLY_KEY } from '../../common/decorators/frontend-only.decorator';
import { STEP_UP_KEY } from '../../common/decorators/step-up.decorator';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

describe('ApiKeyController', () => {
  const apiKeyService = {
    createApiKey: jest.fn(),
    listApiKeys: jest.fn(),
    revokeApiKey: jest.fn(),
    revokeAllKeys: jest.fn(),
    authorizeDirectEgress: jest.fn(),
    replaceCapabilities: jest.fn(),
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
      allowedCapabilityIds: undefined,
      capabilityMode: undefined,
      spendLimits: undefined,
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

  it('passes restriction fields to apiKeyService.createApiKey', async () => {
    apiKeyService.createApiKey.mockResolvedValue({ rawKey: 'sk_test' });

    await controller.create('user-1', {
      name: 'Restricted',
      allowedCapabilityIds: ['cap:test:v1'],
      spendLimits: { daily: '1000', monthly: '5000' },
    } as any);

    expect(apiKeyService.createApiKey).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        allowedCapabilityIds: ['cap:test:v1'],
        spendLimits: { daily: '1000', monthly: '5000' },
      }),
    );
  });

  it('passes complete capability mode replacements to the service', async () => {
    apiKeyService.replaceCapabilities.mockResolvedValue({ id: 'key-1', capabilityMode: 'all', allowedCapabilityIds: [] });
    const dto = { capabilityMode: 'all' };
    await expect(controller.replaceCapabilities('user-1', 'key-1', dto as any)).resolves.toEqual({ id: 'key-1', capabilityMode: 'all', allowedCapabilityIds: [] });
    expect(apiKeyService.replaceCapabilities).toHaveBeenCalledWith('key-1', 'user-1', dto);
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

  it('delegates authorize-direct-egress to apiKeyService.authorizeDirectEgress', async () => {
    apiKeyService.authorizeDirectEgress.mockResolvedValue({
      id: 'key-1',
      outcome: 'authorized',
      directEgressPolicyAcceptedAt: new Date('2026-06-01T00:00:00.000Z'),
    });

    await expect(controller.authorizeDirectEgress('user-1', 'key-1')).resolves.toEqual(
      expect.objectContaining({ id: 'key-1', outcome: 'authorized' }),
    );
    expect(apiKeyService.authorizeDirectEgress).toHaveBeenCalledWith('key-1', 'user-1');
  });
});

describe('DefiCapabilityController', () => {
  it('returns the async catalog response envelope directly', async () => {
    const response = { capabilities: [{ capabilityId: 'cap:test:v1' }] };
    const catalog = { listMetadata: jest.fn().mockResolvedValue(response) };
    const controller = new DefiCapabilityController(catalog as any);
    await expect(controller.list()).resolves.toBe(response);
    expect(catalog.listMetadata).toHaveBeenCalledTimes(1);
  });
});

describe('DefiCapabilityBundleController', () => {
  it('serves bundle metadata through the IAM/frontend-only guarded dashboard route', async () => {
    const response = { schemaVersion: 1, currentCatalogManifestHash: '0xmanifest', bundles: [] };
    const service = { listMetadata: jest.fn().mockResolvedValue(response) };
    const controller = new DefiCapabilityBundleController(service as any);
    await expect(controller.list()).resolves.toBe(response);
    expect(service.listMetadata).toHaveBeenCalledTimes(1);
    expect(Reflect.getMetadata(GUARDS_METADATA, DefiCapabilityBundleController)).toEqual([OpenfortUserGuard, FrontendOnlyGuard]);
    expect(Reflect.getMetadata(IS_FRONTEND_ONLY_KEY, DefiCapabilityBundleController)).toBe(true);
    const listHandler = DefiCapabilityBundleController.prototype.list;
    expect(Reflect.getMetadata(PATH_METADATA, DefiCapabilityBundleController)).toBe('v1/defi-capability-bundles');
    expect(Reflect.getMetadata(PATH_METADATA, listHandler)).toBe('/');
    expect(Reflect.getMetadata(METHOD_METADATA, listHandler)).toBe(0);
    expect(Reflect.getMetadata(STEP_UP_KEY, listHandler)).toBeUndefined();
  });
});
