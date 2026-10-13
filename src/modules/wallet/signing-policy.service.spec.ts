import { BadRequestException, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SigningPolicyService, SigningPolicyContext } from './signing-policy.service';
import { SecurityEventService } from '../security-events/security-event.service';
import type { SignDto } from './dto/sign.dto';

function createTypedData(
  overrides?: Partial<{
    chainId: number | undefined;
    verifyingContract?: string;
    domainName?: string;
    primaryType?: string;
    types?: Record<string, Array<{ name: string; type: string }>>;
    message?: Record<string, unknown>;
    domain?: Record<string, unknown>;
  }>,
): NonNullable<SignDto['typedData']> {
  return {
    domain: {
      name: overrides?.domainName ?? 'SOFA ONE',
      version: '1',
      ...(overrides?.chainId === undefined ? {} : { chainId: overrides.chainId }),
      ...(overrides?.verifyingContract === undefined
        ? {}
        : { verifyingContract: overrides.verifyingContract }),
      ...(overrides?.domain ?? {}),
    },
    types: overrides?.types ?? { Mail: [{ name: 'message', type: 'string' }] },
    primaryType: overrides?.primaryType ?? 'Mail',
    message: overrides?.message ?? { message: 'Hello' },
  };
}

describe('SigningPolicyService', () => {
  let service: SigningPolicyService;
  const mockRecord = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRecord.mockResolvedValue({ id: 'event-1' });

    const module = await Test.createTestingModule({
      providers: [
        SigningPolicyService,
        { provide: SecurityEventService, useValue: { record: mockRecord } },
      ],
    }).compile();

    service = module.get(SigningPolicyService);
  });

  // ── Typed Data Signing Policy ──────────────────────────────────────

  describe('assertTypedDataSigningPolicy', () => {
    const typedDataContext: SigningPolicyContext = {
      userId: 'user-1',
      chainId: 84532,
      type: 'typed_data',
      executionMode: 'session_key',
      apiKeyId: 'api-key-1',
      apiKeyPrefix: 'sk_test',
    };

    it('allows valid typed data', async () => {
      const typedData = createTypedData({
        chainId: 84532,
        verifyingContract: '0x0000000000000000000000000000000000000000',
      });

      const result = await service.assertTypedDataSigningPolicy(
        typedData,
        typedDataContext,
      );

      expect(result).toEqual({
        typedDataPrimaryType: 'Mail',
        typedDataVerifyingContract: '0x0000000000000000000000000000000000000000',
        typedDataDomainName: 'SOFA ONE',
      });
      expect(mockRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'signing.typed_data_allowed',
          result: 'allowed',
        }),
      );
    });

    it('defers successful audit when caller commits its acceptance audit atomically', async () => {
      mockRecord.mockClear();
      await service.assertTypedDataSigningPolicy(createTypedData({ chainId: 84532 }), { ...typedDataContext, deferAllowedAudit: true });
      expect(mockRecord).not.toHaveBeenCalled();
    });

    it('allows typed data without verifyingContract', async () => {
      const typedData = createTypedData({ chainId: 84532 });

      const result = await service.assertTypedDataSigningPolicy(
        typedData,
        typedDataContext,
      );

      expect(result).toEqual({
        typedDataPrimaryType: 'Mail',
        typedDataDomainName: 'SOFA ONE',
      });
      expect(mockRecord).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'signing.typed_data_allowed' }),
      );
    });

    it('allows typed data without domain.name', async () => {
      const typedData = createTypedData({
        chainId: 84532,
        domain: { name: undefined } as unknown as Record<string, unknown>,
      });

      const result = await service.assertTypedDataSigningPolicy(
        typedData,
        typedDataContext,
      );

      expect(result).toEqual({
        typedDataPrimaryType: 'Mail',
      });
      expect(mockRecord).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'signing.typed_data_allowed' }),
      );
    });

    it('rejects missing domain', async () => {
      const typedData = {
        types: { Mail: [{ name: 'message', type: 'string' }] },
        primaryType: 'Mail',
        message: { message: 'Hello' },
      } as unknown as NonNullable<SignDto['typedData']>;

      await expect(
        service.assertTypedDataSigningPolicy(typedData, typedDataContext),
      ).rejects.toThrow('typedData.domain is required');
    });

    it('rejects missing types', async () => {
      const typedData = {
        domain: { name: 'Test', version: '1', chainId: 84532 },
        primaryType: 'Mail',
        message: { message: 'Hello' },
      } as unknown as NonNullable<SignDto['typedData']>;

      await expect(
        service.assertTypedDataSigningPolicy(typedData, typedDataContext),
      ).rejects.toThrow('typedData.types is required');
    });

    it('rejects missing primaryType', async () => {
      const typedData = {
        domain: { name: 'Test', version: '1', chainId: 84532 },
        types: { Mail: [{ name: 'message', type: 'string' }] },
        message: { message: 'Hello' },
      } as unknown as NonNullable<SignDto['typedData']>;

      await expect(
        service.assertTypedDataSigningPolicy(typedData, typedDataContext),
      ).rejects.toThrow('typedData.primaryType is required');
    });

    it('rejects missing message', async () => {
      const typedData = {
        domain: { name: 'Test', version: '1', chainId: 84532 },
        types: { Mail: [{ name: 'message', type: 'string' }] },
        primaryType: 'Mail',
      } as unknown as NonNullable<SignDto['typedData']>;

      await expect(
        service.assertTypedDataSigningPolicy(typedData, typedDataContext),
      ).rejects.toThrow('typedData.message is required');
    });

    it('rejects Permit primary type (case-insensitive)', async () => {
      const typedData = createTypedData({ chainId: 84532, primaryType: 'Permit' });

      await expect(
        service.assertTypedDataSigningPolicy(typedData, typedDataContext),
      ).rejects.toThrow('Permit typed data signing is not allowed');
    });

    it('rejects PermitBatch primary type', async () => {
      const typedData = createTypedData({
        chainId: 84532,
        primaryType: 'PermitBatch',
      });

      await expect(
        service.assertTypedDataSigningPolicy(typedData, typedDataContext),
      ).rejects.toThrow('Permit typed data signing is not allowed');
    });

    it('rejects invalid verifyingContract', async () => {
      const typedData = createTypedData({
        chainId: 84532,
        verifyingContract: 'not-an-address',
      });

      await expect(
        service.assertTypedDataSigningPolicy(typedData, typedDataContext),
      ).rejects.toThrow(
        'typedData.domain.verifyingContract must be a valid address',
      );
    });

    it('rejects domain.chainId mismatch', async () => {
      const typedData = createTypedData({ chainId: 1 });

      await expect(
        service.assertTypedDataSigningPolicy(typedData, typedDataContext),
      ).rejects.toThrow('typedData.domain.chainId must match the request chainId');
    });

    it('rejects missing domain.chainId', async () => {
      const typedData = createTypedData({ chainId: undefined });

      await expect(
        service.assertTypedDataSigningPolicy(typedData, typedDataContext),
      ).rejects.toThrow(
        'typedData.domain.chainId is required and must be a number',
      );
    });

    it('rejects domain.name exceeding 100 characters', async () => {
      const typedData = createTypedData({
        chainId: 84532,
        domainName: 'a'.repeat(101),
      });

      await expect(
        service.assertTypedDataSigningPolicy(typedData, typedDataContext),
      ).rejects.toThrow('typedData.domain.name must not exceed 100 characters');
    });

    it('records denied event for Permit with correct metadata', async () => {
      const typedData = createTypedData({ chainId: 84532, primaryType: 'Permit' });

      await expect(
        service.assertTypedDataSigningPolicy(typedData, typedDataContext),
      ).rejects.toThrow('Permit typed data signing is not allowed');

      expect(mockRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'signing.policy_denied',
          result: 'denied',
          reason: 'Permit typed data signing is not allowed',
          metadata: expect.objectContaining({
            typedDataPrimaryType: 'Permit',
          }),
        }),
      );
    });

    it('records allowed event with correct metadata', async () => {
      const typedData = createTypedData({
        chainId: 84532,
        verifyingContract: '0x0000000000000000000000000000000000000000',
        domainName: 'My DApp',
        primaryType: 'Mail',
      });

      const result = await service.assertTypedDataSigningPolicy(
        typedData,
        typedDataContext,
      );

      expect(result).toEqual({
        typedDataPrimaryType: 'Mail',
        typedDataVerifyingContract: '0x0000000000000000000000000000000000000000',
        typedDataDomainName: 'My DApp',
      });

      expect(mockRecord).toHaveBeenCalledWith({
        actorType: 'api_key',
        eventType: 'signing.typed_data_allowed',
        userId: 'user-1',
        apiKeyId: 'api-key-1',
        result: 'allowed',
        metadata: {
          chainId: 84532,
          executionMode: 'session_key',
          apiKeyPrefix: 'sk_test',
          type: 'typed_data',
          primaryType: 'Mail',
          verifyingContract: '0x0000000000000000000000000000000000000000',
          domainName: 'My DApp',
        },
      });
    });

    it('works without SecurityEventService', async () => {
      const loggerWarnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      const module = await Test.createTestingModule({
        providers: [SigningPolicyService],
      }).compile();
      const serviceWithout = module.get(SigningPolicyService);

      const validTypedData = createTypedData({ chainId: 84532 });

      // Allowed should not throw and should return result
      const result = await serviceWithout.assertTypedDataSigningPolicy(
        validTypedData,
        typedDataContext,
      );
      expect(result).toEqual({
        typedDataPrimaryType: 'Mail',
        typedDataDomainName: 'SOFA ONE',
      });

      // Denied should throw and log warning
      const permitTypedData = createTypedData({
        chainId: 84532,
        primaryType: 'Permit',
      });
      await expect(
        serviceWithout.assertTypedDataSigningPolicy(permitTypedData, typedDataContext),
      ).rejects.toThrow(BadRequestException);

      expect(loggerWarnSpy).toHaveBeenCalled();

      loggerWarnSpy.mockRestore();
    });

  });
});
