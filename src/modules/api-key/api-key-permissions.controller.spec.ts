import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ApiKeyAuthGuard } from '../../common/guards/api-key-auth.guard';
import { ApiKeyPermissionsController } from './api-key-permissions.controller';

describe('ApiKeyPermissionsController', () => {
  const response = () => ({ setHeader: jest.fn() });

  it('is an API-key-only route and projects defaults with no-store', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ApiKeyPermissionsController)).toEqual([
      ApiKeyAuthGuard,
    ]);
    expect(Reflect.getMetadata(PATH_METADATA, ApiKeyPermissionsController)).toBe('v1/permissions');
    const res = response();
    const value = new ApiKeyPermissionsController().getPermissions(
      { apiKeyRecord: { capabilityMode: 'all', allowedCapabilityIds: [] } },
      res,
    );
    expect(value).toMatchObject({
      evaluation: 'configured',
      permissions: {
        canSign: false,
        canSendTransaction: false,
        canReadTransactionStatus: true,
        canUseEoaExecution: false,
      },
      capabilities: { mode: 'all', allowedIds: [] },
      constraints: { expiresAt: null, allowedIps: [], spendLimits: { daily: null, monthly: null } },
    });
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  it('returns custom empty IDs and configured restrictions only', () => {
    const value = new ApiKeyPermissionsController().getPermissions(
      {
        apiKeyRecord: {
          canSign: true,
          canSendTransaction: false,
          canReadTransactionStatus: false,
          canUseEoaExecution: true,
          capabilityMode: 'custom',
          allowedCapabilityIds: [],
          allowedIps: ['192.0.2.1'],
          dailySpendLimit: '10',
          monthlySpendLimit: '20',
          expiresAt: '2030-01-01T00:00:00.000Z',
          apiKeyHash: 'secret',
        },
      },
      response(),
    );
    expect(value).toMatchObject({
      permissions: {
        canSign: true,
        canSendTransaction: false,
        canReadTransactionStatus: false,
        canUseEoaExecution: true,
      },
      capabilities: { mode: 'custom', allowedIds: [] },
      constraints: {
        expiresAt: '2030-01-01T00:00:00.000Z',
        allowedIps: ['192.0.2.1'],
        spendLimits: { daily: '10', monthly: '20' },
      },
    });
    expect(JSON.stringify(value)).not.toContain('secret');
  });
});
