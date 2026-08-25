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

const DEFAULT_CONTEXT: SigningPolicyContext = {
  userId: 'user-1',
  chainId: 84532,
  type: 'message',
  executionMode: 'session_key',
  apiKeyId: 'api-key-1',
  apiKeyPrefix: 'sk_test',
};

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

  // ── Message Signing Policy ─────────────────────────────────────────

  describe('assertMessageSigningPolicy', () => {
    it('allows a normal short message', async () => {
      const result = await service.assertMessageSigningPolicy(
        'Hello, world!',
        DEFAULT_CONTEXT,
      );

      expect(result).toEqual({});
      expect(mockRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'signing.message_allowed',
          result: 'allowed',
        }),
      );
    });

    it('allows a message at exactly 10 KB', async () => {
      const message = 'a'.repeat(10 * 1024); // 10240 bytes
      const result = await service.assertMessageSigningPolicy(message, DEFAULT_CONTEXT);

      expect(result).toEqual({});
      expect(mockRecord).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'signing.message_allowed' }),
      );
    });

    it('rejects a message exceeding 10 KB', async () => {
      const message = 'a'.repeat(10 * 1024 + 1); // 10241 bytes
      await expect(
        service.assertMessageSigningPolicy(message, DEFAULT_CONTEXT),
      ).rejects.toThrow('Message exceeds maximum allowed length');

      expect(mockRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'signing.policy_denied',
          result: 'denied',
          reason: 'Message exceeds maximum allowed length',
          metadata: expect.objectContaining({
            messageLength: 10241,
          }),
        }),
      );
    });

    it('rejects a message containing a private key pattern', async () => {
      const message = 'Here is my key: 0x' + 'a'.repeat(64);
      await expect(
        service.assertMessageSigningPolicy(message, DEFAULT_CONTEXT),
      ).rejects.toThrow('Message appears to contain a private key');
    });

    it('allows raw hex messages of 32 bytes or more', async () => {
      const message = { raw: `0x${'a'.repeat(64)}` as `0x${string}` };

      const result = await service.assertMessageSigningPolicy(message, DEFAULT_CONTEXT);

      expect(result).toEqual({});
      expect(mockRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'signing.message_allowed',
          metadata: expect.objectContaining({
            messageLength: 32,
          }),
        }),
      );
    });

    it('rejects a message containing a mnemonic phrase', async () => {
      const words = [
        'abandon',
        'abandon',
        'abandon',
        'abandon',
        'abandon',
        'abandon',
        'abandon',
        'abandon',
        'abandon',
        'abandon',
        'abandon',
        'about',
      ];
      const message = words.join(' ');
      await expect(
        service.assertMessageSigningPolicy(message, DEFAULT_CONTEXT),
      ).rejects.toThrow('Message appears to contain a mnemonic phrase');
    });

    it('allows a message with a short hex string', async () => {
      const result = await service.assertMessageSigningPolicy(
        '0x1234',
        DEFAULT_CONTEXT,
      );

      expect(result).toEqual({});
      expect(mockRecord).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'signing.message_allowed' }),
      );
    });

    it('allows a normal English sentence', async () => {
      const result = await service.assertMessageSigningPolicy(
        'The quick brown fox jumps over the lazy dog.',
        DEFAULT_CONTEXT,
      );

      expect(result).toEqual({});
      expect(mockRecord).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'signing.message_allowed' }),
      );
    });

    it('records allowed event with correct metadata', async () => {
      await service.assertMessageSigningPolicy('Hello', DEFAULT_CONTEXT);

      expect(mockRecord).toHaveBeenCalledWith({
        actorType: 'api_key',
        eventType: 'signing.message_allowed',
        userId: 'user-1',
        apiKeyId: 'api-key-1',
        result: 'allowed',
        metadata: {
          chainId: 84532,
          executionMode: 'session_key',
          apiKeyPrefix: 'sk_test',
          type: 'message',
          messageLength: 5,
        },
      });
    });

    it('records denied event with correct metadata', async () => {
      const message = 'a'.repeat(10 * 1024 + 1);
      await expect(
        service.assertMessageSigningPolicy(message, DEFAULT_CONTEXT),
      ).rejects.toThrow(BadRequestException);

      expect(mockRecord).toHaveBeenCalledWith({
        actorType: 'api_key',
        eventType: 'signing.policy_denied',
        userId: 'user-1',
        apiKeyId: 'api-key-1',
        result: 'denied',
        reason: 'Message exceeds maximum allowed length',
        metadata: {
          chainId: 84532,
          executionMode: 'session_key',
          apiKeyPrefix: 'sk_test',
          messageLength: 10241,
          maxLength: 10240,
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

      await expect(
        serviceWithout.assertMessageSigningPolicy('Hello', DEFAULT_CONTEXT),
      ).resolves.toEqual({});

      const longMsg = 'a'.repeat(10 * 1024 + 1);
      await expect(
        serviceWithout.assertMessageSigningPolicy(longMsg, DEFAULT_CONTEXT),
      ).rejects.toThrow(BadRequestException);

      expect(loggerWarnSpy).toHaveBeenCalled();

      loggerWarnSpy.mockRestore();
    });

    it('handles SecurityEventService.record() failure gracefully for allowed events', async () => {
      mockRecord.mockRejectedValue(new Error('DB connection failed'));

      await expect(
        service.assertMessageSigningPolicy('Hello', DEFAULT_CONTEXT),
      ).resolves.toEqual({});
    });

    it('handles SecurityEventService.record() failure gracefully for denied events', async () => {
      mockRecord.mockRejectedValue(new Error('DB connection failed'));

      const message = 'a'.repeat(10 * 1024 + 1);
      await expect(
        service.assertMessageSigningPolicy(message, DEFAULT_CONTEXT),
      ).rejects.toThrow('Message exceeds maximum allowed length');
    });
  });

  // ── Typed Data Signing Policy ──────────────────────────────────────

  describe('assertTypedDataSigningPolicy', () => {
    const typedDataContext: SigningPolicyContext = {
      ...DEFAULT_CONTEXT,
      type: 'typed_data',
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

    // ── Contract allowlist ──────────────────────────────────────────────

    it('allows typed data signing when verifyingContract is in allowedContracts', async () => {
      const contract = '0x0000000000000000000000000000000000000000';
      const typedData = createTypedData({ chainId: 84532, verifyingContract: contract });
      const contextWithAllowlist = {
        ...typedDataContext,
        allowedContracts: [contract],
      };
      const result = await service.assertTypedDataSigningPolicy(typedData, contextWithAllowlist);
      expect(result.typedDataVerifyingContract).toBe(contract);
    });

    it('rejects typed data signing when verifyingContract is not in allowedContracts', async () => {
      const contract = '0x0000000000000000000000000000000000000000';
      const typedData = createTypedData({ chainId: 84532, verifyingContract: contract });
      const contextWithAllowlist = {
        ...typedDataContext,
        allowedContracts: ['0x1111111111111111111111111111111111111111'],
      };
      await expect(
        service.assertTypedDataSigningPolicy(typedData, contextWithAllowlist),
      ).rejects.toThrow('not in the API key allowed contracts');
    });

    it('contract allowlist is case-insensitive', async () => {
      const contract = '0x0000000000000000000000000000000000000000';
      const typedData = createTypedData({ chainId: 84532, verifyingContract: contract });
      const contextWithAllowlist = {
        ...typedDataContext,
        allowedContracts: [contract.toUpperCase()],
      };
      await expect(
        service.assertTypedDataSigningPolicy(typedData, contextWithAllowlist),
      ).resolves.toBeDefined();
    });

    it('skips contract allowlist check when allowedContracts is empty', async () => {
      const contract = '0x0000000000000000000000000000000000000000';
      const typedData = createTypedData({ chainId: 84532, verifyingContract: contract });
      const contextWithAllowlist = { ...typedDataContext, allowedContracts: [] };
      await expect(
        service.assertTypedDataSigningPolicy(typedData, contextWithAllowlist),
      ).resolves.toBeDefined();
    });

    it('skips contract allowlist check when allowedContracts is undefined', async () => {
      const contract = '0x0000000000000000000000000000000000000000';
      const typedData = createTypedData({ chainId: 84532, verifyingContract: contract });
      await expect(
        service.assertTypedDataSigningPolicy(typedData, typedDataContext),
      ).resolves.toBeDefined();
    });

    it('rejects typed data without verifyingContract when allowedContracts is set', async () => {
      const typedData = createTypedData({ chainId: 84532 });
      const contextWithAllowlist = {
        ...typedDataContext,
        allowedContracts: ['0x1111111111111111111111111111111111111111'],
      };
      await expect(
        service.assertTypedDataSigningPolicy(typedData, contextWithAllowlist),
      ).rejects.toThrow(
        'typedData.domain.verifyingContract is required when API key allowed contracts are configured',
      );
    });
  });
});
