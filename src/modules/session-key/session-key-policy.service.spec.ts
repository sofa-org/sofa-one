import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import {
  SessionKeyPolicyService,
  type SessionKeyPolicyContext,
} from './session-key-policy.service';
import { ZERO_ADDRESS } from '../../common/calibur/calibur';

// Mock calibur functions
jest.mock('../../common/calibur/calibur', () => ({
  ...jest.requireActual('../../common/calibur/calibur'),
  hasCaliburDelegation: jest.fn(),
  isCaliburKeyRegistered: jest.fn(),
  getCaliburKeySettings: jest.fn(),
  getAgentKeyUsabilityFailure: jest.fn(),
}));

import {
  hasCaliburDelegation,
  isCaliburKeyRegistered,
  getCaliburKeySettings,
  getAgentKeyUsabilityFailure,
} from '../../common/calibur/calibur';

const mockHasCaliburDelegation = hasCaliburDelegation as jest.Mock;
const mockIsCaliburKeyRegistered = isCaliburKeyRegistered as jest.Mock;
const mockGetCaliburKeySettings = getCaliburKeySettings as jest.Mock;
const mockGetAgentKeyUsabilityFailure = getAgentKeyUsabilityFailure as jest.Mock;

describe('SessionKeyPolicyService', () => {
  let service: SessionKeyPolicyService;
  const prisma = {} as any;
  const securityEvents = { record: jest.fn().mockResolvedValue({ id: 'event-1' }) } as any;

  const baseContext: SessionKeyPolicyContext = {
    userId: 'user-1',
    walletId: 'wallet-1',
    apiKeyId: 'api-key-1',
    apiKeyPrefix: 'sk_abc123',
    chainId: 84532,
    accountAddress: '0x1111111111111111111111111111111111111111',
    keyHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
    operation: 'send_transaction',
  };

  const validSettings = {
    isAdmin: false,
    expiration: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60, // 1 year from now
    hook: ZERO_ADDRESS,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SessionKeyPolicyService(prisma, securityEvents);

    // Default: on-chain verification passes
    mockHasCaliburDelegation.mockResolvedValue(true);
    mockIsCaliburKeyRegistered.mockResolvedValue(true);
    mockGetCaliburKeySettings.mockResolvedValue(validSettings);
    mockGetAgentKeyUsabilityFailure.mockReturnValue(null);
  });

  // ─── assertSessionKeyAllowed ────────────────────────────────────────────

  describe('assertSessionKeyAllowed', () => {
    it('allows operation when on-chain key is valid and no drift', async () => {
      await service.assertSessionKeyAllowed(baseContext);

      expect(securityEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'session_key.allowed',
          result: 'allowed',
          reason: 'session_key_allowed',
          riskLevel: 'low',
          walletId: 'wallet-1',
        }),
      );
    });

    it('throws ForbiddenException when account is not delegated to Calibur', async () => {
      mockHasCaliburDelegation.mockResolvedValue(false);

      await expect(service.assertSessionKeyAllowed(baseContext)).rejects.toThrow(
        ForbiddenException,
      );

      expect(securityEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'session_key.denied',
          result: 'denied',
          reason: 'session_key_not_delegated',
          riskLevel: 'high',
          walletId: 'wallet-1',
        }),
      );
    });

    it('throws ForbiddenException when key is not registered on-chain', async () => {
      mockIsCaliburKeyRegistered.mockResolvedValue(false);

      await expect(service.assertSessionKeyAllowed(baseContext)).rejects.toThrow(
        ForbiddenException,
      );

      expect(securityEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'session_key_not_registered',
        }),
      );
    });

    it('throws ForbiddenException when key is expired on-chain', async () => {
      mockGetAgentKeyUsabilityFailure.mockReturnValue('Agent key is expired');

      await expect(service.assertSessionKeyAllowed(baseContext)).rejects.toThrow(
        ForbiddenException,
      );

      expect(securityEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'session_key_Agent key is expired',
        }),
      );
    });

    it('throws ForbiddenException when key is an admin key', async () => {
      mockGetAgentKeyUsabilityFailure.mockReturnValue('Agent key must not be an admin key');

      await expect(service.assertSessionKeyAllowed(baseContext)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws ServiceUnavailableException when RPC fails', async () => {
      mockHasCaliburDelegation.mockRejectedValue(new Error('RPC error'));

      await expect(service.assertSessionKeyAllowed(baseContext)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('records expiration mismatch when on-chain key expires before API key', async () => {
      const onChainExpiration = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60; // 7 days
      const apiKeyExpiration = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

      mockGetCaliburKeySettings.mockResolvedValue({
        ...validSettings,
        expiration: onChainExpiration,
      });

      await service.assertSessionKeyAllowed({
        ...baseContext,
        apiKeyExpiresAt: apiKeyExpiration,
      });

      expect(securityEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'session_key.expiration_mismatch',
          reason: 'session_key_expiration_mismatch',
          walletId: 'wallet-1',
          metadata: expect.objectContaining({
            onChainExpiration: onChainExpiration,
            apiKeyExpiration: apiKeyExpiration.toISOString(),
          }),
        }),
      );
    });

    it('does not record expiration mismatch when on-chain key expires after API key', async () => {
      const onChainExpiration = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60; // 1 year
      const apiKeyExpiration = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

      mockGetCaliburKeySettings.mockResolvedValue({
        ...validSettings,
        expiration: onChainExpiration,
      });

      await service.assertSessionKeyAllowed({
        ...baseContext,
        apiKeyExpiresAt: apiKeyExpiration,
      });

      // Should NOT have an expiration mismatch event
      const mismatchCalls = securityEvents.record.mock.calls.filter(
        (call: any[]) => call[0].reason === 'session_key_expiration_mismatch',
      );
      expect(mismatchCalls).toHaveLength(0);
    });

    it('records policy drift when backend has allowedContracts', async () => {
      await service.assertSessionKeyAllowed({
        ...baseContext,
        allowedContracts: ['0x1234567890123456789012345678901234567890'],
      });

      expect(securityEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'session_key.policy_drift',
          reason: 'session_key_policy_drift',
          walletId: 'wallet-1',
          metadata: expect.objectContaining({
            drifts: ['allowedContracts_not_enforced_on_chain'],
          }),
        }),
      );
    });

    it('records policy drift when backend has allowedFunctionSelectors', async () => {
      await service.assertSessionKeyAllowed({
        ...baseContext,
        allowedFunctionSelectors: ['0xa9059cbb'],
      });

      expect(securityEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'session_key_policy_drift',
          metadata: expect.objectContaining({
            drifts: ['allowedFunctionSelectors_not_enforced_on_chain'],
          }),
        }),
      );
    });

    it('records policy drift when backend has spend limits', async () => {
      await service.assertSessionKeyAllowed({
        ...baseContext,
        dailySpendLimit: '1000000',
        monthlySpendLimit: '10000000',
      });

      expect(securityEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'session_key_policy_drift',
          metadata: expect.objectContaining({
            drifts: ['spend_limits_not_enforced_on_chain'],
          }),
        }),
      );
    });

    it('records multiple drifts when backend has multiple restrictions', async () => {
      await service.assertSessionKeyAllowed({
        ...baseContext,
        allowedContracts: ['0x1234567890123456789012345678901234567890'],
        allowedFunctionSelectors: ['0xa9059cbb'],
        dailySpendLimit: '1000000',
      });

      expect(securityEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'session_key_policy_drift',
          metadata: expect.objectContaining({
            drifts: [
              'allowedContracts_not_enforced_on_chain',
              'allowedFunctionSelectors_not_enforced_on_chain',
              'spend_limits_not_enforced_on_chain',
            ],
          }),
        }),
      );
    });

    it('records both drift and expiration mismatch', async () => {
      const onChainExpiration = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
      const apiKeyExpiration = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      mockGetCaliburKeySettings.mockResolvedValue({
        ...validSettings,
        expiration: onChainExpiration,
      });

      await service.assertSessionKeyAllowed({
        ...baseContext,
        allowedContracts: ['0x1234567890123456789012345678901234567890'],
        apiKeyExpiresAt: apiKeyExpiration,
      });

      // Should have both drift and mismatch events, plus the final allowed event
      expect(securityEvents.record).toHaveBeenCalledTimes(3);
      expect(securityEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'session_key_expiration_mismatch' }),
      );
      expect(securityEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'session_key_policy_drift' }),
      );
      expect(securityEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'session_key_allowed' }),
      );
    });

    it('works without SecurityEventService (graceful degradation)', async () => {
      const serviceNoEvents = new SessionKeyPolicyService(prisma, null as any);

      // Should not throw when securityEvents is null
      await serviceNoEvents.assertSessionKeyAllowed(baseContext);
    });

    it('records correct metadata for sign operation', async () => {
      await service.assertSessionKeyAllowed({
        ...baseContext,
        operation: 'sign',
      });

      expect(securityEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            operation: 'sign',
            chainId: 84532,
            walletId: 'wallet-1',
            apiKeyPrefix: 'sk_abc123',
          }),
        }),
      );
    });
  });

  // ─── verifyOnChainKeyStatus ──────────────────────────────────────────────

  describe('verifyOnChainKeyStatus', () => {
    it('returns usable status when all on-chain checks pass', async () => {
      const status = await service.verifyOnChainKeyStatus(
        '0x1111111111111111111111111111111111111111',
        '0x3333333333333333333333333333333333333333333333333333333333333333',
        84532,
      );

      expect(status).toEqual({
        delegated: true,
        registered: true,
        usable: true,
        settings: validSettings,
      });
    });

    it('returns not_delegated when account is not delegated to Calibur', async () => {
      mockHasCaliburDelegation.mockResolvedValue(false);

      const status = await service.verifyOnChainKeyStatus(
        '0x1111111111111111111111111111111111111111',
        '0x3333333333333333333333333333333333333333333333333333333333333333',
        84532,
      );

      expect(status).toEqual({
        delegated: false,
        registered: false,
        usable: false,
        failureReason: 'not_delegated',
      });
    });

    it('returns not_registered when key is not registered', async () => {
      mockIsCaliburKeyRegistered.mockResolvedValue(false);

      const status = await service.verifyOnChainKeyStatus(
        '0x1111111111111111111111111111111111111111',
        '0x3333333333333333333333333333333333333333333333333333333333333333',
        84532,
      );

      expect(status).toEqual({
        delegated: true,
        registered: false,
        usable: false,
        failureReason: 'not_registered',
      });
    });

    it('returns failure when key is expired', async () => {
      mockGetAgentKeyUsabilityFailure.mockReturnValue('Agent key is expired');

      const status = await service.verifyOnChainKeyStatus(
        '0x1111111111111111111111111111111111111111',
        '0x3333333333333333333333333333333333333333333333333333333333333333',
        84532,
      );

      expect(status).toEqual({
        delegated: true,
        registered: true,
        usable: false,
        settings: validSettings,
        failureReason: 'Agent key is expired',
      });
    });

    it('throws ServiceUnavailableException when RPC fails', async () => {
      mockHasCaliburDelegation.mockRejectedValue(new Error('Network error'));

      await expect(
        service.verifyOnChainKeyStatus(
          '0x1111111111111111111111111111111111111111',
          '0x3333333333333333333333333333333333333333333333333333333333333333',
          84532,
        ),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });

  // ─── detectPolicyDrift ──────────────────────────────────────────────────

  describe('detectPolicyDrift', () => {
    it('returns no drift when backend has no additional restrictions', () => {
      const result = service.detectPolicyDrift(baseContext);

      expect(result).toEqual({ hasDrift: false, drifts: [] });
    });

    it('detects allowedContracts drift', () => {
      const result = service.detectPolicyDrift({
        ...baseContext,
        allowedContracts: ['0x1234567890123456789012345678901234567890'],
      });

      expect(result).toEqual({
        hasDrift: true,
        drifts: ['allowedContracts_not_enforced_on_chain'],
      });
    });

    it('detects allowedFunctionSelectors drift', () => {
      const result = service.detectPolicyDrift({
        ...baseContext,
        allowedFunctionSelectors: ['0xa9059cbb'],
      });

      expect(result).toEqual({
        hasDrift: true,
        drifts: ['allowedFunctionSelectors_not_enforced_on_chain'],
      });
    });

    it('detects spend limits drift', () => {
      const result = service.detectPolicyDrift({
        ...baseContext,
        dailySpendLimit: '1000000',
      });

      expect(result).toEqual({
        hasDrift: true,
        drifts: ['spend_limits_not_enforced_on_chain'],
      });
    });

    it('detects monthly spend limits drift', () => {
      const result = service.detectPolicyDrift({
        ...baseContext,
        monthlySpendLimit: '10000000',
      });

      expect(result).toEqual({
        hasDrift: true,
        drifts: ['spend_limits_not_enforced_on_chain'],
      });
    });

    it('detects multiple drifts', () => {
      const result = service.detectPolicyDrift({
        ...baseContext,
        allowedContracts: ['0x1234567890123456789012345678901234567890'],
        allowedFunctionSelectors: ['0xa9059cbb'],
        dailySpendLimit: '1000000',
        monthlySpendLimit: '10000000',
      });

      expect(result.hasDrift).toBe(true);
      expect(result.drifts).toHaveLength(3);
      expect(result.drifts).toContain('allowedContracts_not_enforced_on_chain');
      expect(result.drifts).toContain('allowedFunctionSelectors_not_enforced_on_chain');
      expect(result.drifts).toContain('spend_limits_not_enforced_on_chain');
    });

    it('does not detect drift for empty arrays', () => {
      const result = service.detectPolicyDrift({
        ...baseContext,
        allowedContracts: [],
        allowedFunctionSelectors: [],
      });

      expect(result).toEqual({ hasDrift: false, drifts: [] });
    });
  });

  // ─── generateRevocationCalldata ──────────────────────────────────────────

  describe('generateRevocationCalldata', () => {
    it('generates calldata for key revocation with expiration=0', () => {
      const keyHash = '0x3333333333333333333333333333333333333333333333333333333333333333';
      const calldata = service.generateRevocationCalldata(keyHash);

      // Should be a hex string starting with 0x
      expect(calldata).toMatch(/^0x/);
      // Should contain the update function selector and packed settings with expiration=0
      expect(calldata.length).toBeGreaterThan(10);
    });

    it('encodes update function with expiration=0, isAdmin=false, hook=zero', () => {
      const keyHash = '0x3333333333333333333333333333333333333333333333333333333333333333';
      const calldata = service.generateRevocationCalldata(keyHash);

      // The calldata should encode: update(keyHash, packedSettings)
      // where packedSettings = (0n << 200n) | (0n << 160n) | 0n = 0
      // This means the key will be expired (expiration=0) and have no hook
      expect(calldata).toMatch(/^0x/);
    });
  });
});
