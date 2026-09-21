import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { getAddress } from 'viem';
import { API_ERROR_CODES } from '../../common/errors/api-error-codes';
import {
  isDeferredDestinationPolicyDenial,
  WithdrawalDestinationPolicyService,
} from './withdrawal-destination-policy.service';

const USER = 'user-1';
const DEST = '0x2222222222222222222222222222222222222222';

describe('WithdrawalDestinationPolicyService', () => {
  const findPolicy = jest.fn();
  const findAddress = jest.fn();
  const executeRaw = jest.fn();
  const record = jest.fn();

  let service: WithdrawalDestinationPolicyService;

  beforeEach(() => {
    jest.clearAllMocks();
    const prisma = {
      withdrawalPolicy: { findUnique: findPolicy },
      withdrawalAddress: { findUnique: findAddress },
      $executeRaw: executeRaw,
    };
    service = new WithdrawalDestinationPolicyService(
      prisma as never,
      {
        record,
      } as never,
    );
  });

  it('allows all destinations when policy is missing or allowlist disabled', async () => {
    findPolicy.mockResolvedValue(null);
    await expect(
      service.assertDestinationsAllowed(USER, [DEST], { apiKeyPrefix: 'sk_test' }),
    ).resolves.toBeUndefined();
    expect(findAddress).not.toHaveBeenCalled();

    findPolicy.mockResolvedValue({
      id: 'pol-1',
      requireAddressAllowlist: false,
      newAddressCooldownHours: 24,
    });
    await expect(service.assertDestinationsAllowed(USER, [DEST])).resolves.toBeUndefined();
  });

  it('rejects destinations not on the allowlist (default actorType api_key, audits immediately)', async () => {
    findPolicy.mockResolvedValue({
      id: 'pol-1',
      requireAddressAllowlist: true,
      newAddressCooldownHours: 24,
    });
    findAddress.mockResolvedValue(null);

    await expect(
      service.assertDestinationsAllowed(USER, [DEST], {
        actorType: 'api_key',
        apiKeyId: 'k1',
        apiKeyPrefix: 'sk_test',
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        response: expect.objectContaining({
          code: API_ERROR_CODES.WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED,
        }),
      }),
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'transaction.destination_policy_denied',
        actorType: 'api_key',
        userId: USER,
        apiKeyId: 'k1',
        metadata: expect.objectContaining({
          code: API_ERROR_CODES.WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED,
          apiKeyPrefix: 'sk_test',
        }),
      }),
    );
  });

  it('deferAudit throws DeferredDestinationPolicyDenial without calling securityEvents', async () => {
    findPolicy.mockResolvedValue({
      id: 'pol-1',
      requireAddressAllowlist: true,
      newAddressCooldownHours: 24,
    });
    findAddress.mockResolvedValue(null);

    let caught: unknown;
    try {
      await service.assertDestinationsAllowed(
        USER,
        [DEST],
        {
          actorType: 'api_key',
          apiKeyId: 'k1',
          apiKeyPrefix: 'sk_ab',
          chainId: 84532,
          executionMode: 'session_key',
        },
        { deferAudit: true },
      );
    } catch (err) {
      caught = err;
    }

    expect(isDeferredDestinationPolicyDenial(caught)).toBe(true);
    expect(record).not.toHaveBeenCalled();
    if (!isDeferredDestinationPolicyDenial(caught)) return;
    expect(caught.httpException).toBeInstanceOf(ForbiddenException);
    expect(caught.audit).toEqual(
      expect.objectContaining({
        actorType: 'api_key',
        userId: USER,
        apiKeyId: 'k1',
        reason: 'Withdrawal address is not allowlisted',
        metadata: expect.objectContaining({
          code: API_ERROR_CODES.WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED,
          apiKeyPrefix: 'sk_ab',
          chainId: 84532,
          executionMode: 'session_key',
        }),
      }),
    );

    await service.recordDeferredDenial(caught);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'api_key',
        apiKeyId: 'k1',
        eventType: 'transaction.destination_policy_denied',
      }),
    );
  });

  it('deferAudit user actor omits API-key fields in deferred payload', async () => {
    findPolicy.mockResolvedValue({
      id: 'pol-1',
      requireAddressAllowlist: true,
      newAddressCooldownHours: 24,
    });
    findAddress.mockResolvedValue(null);

    let caught: unknown;
    try {
      await service.assertDestinationsAllowed(
        USER,
        [DEST],
        {
          actorType: 'user',
          walletId: 'w1',
          chainId: 84532,
          apiKeyId: 'should-not-appear',
          apiKeyPrefix: 'sk_nope',
        },
        { deferAudit: true },
      );
    } catch (err) {
      caught = err;
    }
    expect(isDeferredDestinationPolicyDenial(caught)).toBe(true);
    if (!isDeferredDestinationPolicyDenial(caught)) return;
    expect(caught.audit.actorType).toBe('user');
    expect(caught.audit.apiKeyId).toBeUndefined();
    expect(caught.audit.metadata).not.toHaveProperty('apiKeyPrefix');
    expect(caught.audit.walletId).toBe('w1');
    expect(record).not.toHaveBeenCalled();
  });

  it('records user actor denials without API-key fields (immediate audit)', async () => {
    findPolicy.mockResolvedValue({
      id: 'pol-1',
      requireAddressAllowlist: true,
      newAddressCooldownHours: 24,
    });
    findAddress.mockResolvedValue(null);

    await expect(
      service.assertDestinationsAllowed(USER, [DEST], {
        actorType: 'user',
        walletId: 'wallet-1',
        chainId: 84532,
        apiKeyId: 'should-not-appear',
        apiKeyPrefix: 'sk_nope',
      }),
    ).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED },
    });

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'transaction.destination_policy_denied',
        actorType: 'user',
        userId: USER,
        walletId: 'wallet-1',
        apiKeyId: undefined,
        metadata: expect.objectContaining({
          code: API_ERROR_CODES.WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED,
          chainId: 84532,
          policyId: 'pol-1',
        }),
      }),
    );
    const meta = record.mock.calls[0][0].metadata as Record<string, unknown>;
    expect(meta).not.toHaveProperty('apiKeyPrefix');
    expect(meta).not.toHaveProperty('executionMode');
  });

  it('rejects allowlisted destinations still in cooldown', async () => {
    findPolicy.mockResolvedValue({
      id: 'pol-1',
      requireAddressAllowlist: true,
      newAddressCooldownHours: 24,
    });
    findAddress.mockResolvedValue({
      availableAt: new Date(Date.now() + 60_000),
    });

    await expect(service.assertDestinationsAllowed(USER, [DEST])).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.assertDestinationsAllowed(USER, [DEST])).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.WITHDRAWAL_ADDRESS_IN_COOLDOWN },
    });
  });

  it('allows allowlisted destinations past cooldown', async () => {
    findPolicy.mockResolvedValue({
      id: 'pol-1',
      requireAddressAllowlist: true,
      newAddressCooldownHours: 24,
    });
    findAddress.mockResolvedValue({
      availableAt: new Date(Date.now() - 60_000),
    });

    await expect(
      service.assertDestinationsAllowed(USER, [getAddress(DEST)]),
    ).resolves.toBeUndefined();
  });

  it('fails closed with 503 when policy DB lookup throws', async () => {
    findPolicy.mockRejectedValue(new Error('db down'));
    await expect(service.assertDestinationsAllowed(USER, [DEST])).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.assertDestinationsAllowed(USER, [DEST])).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.WITHDRAWAL_DESTINATION_POLICY_UNAVAILABLE },
    });
  });

  it('deferAudit 503 also avoids securityEvents until recordDeferredDenial', async () => {
    findPolicy.mockRejectedValue(new Error('db down'));
    let caught: unknown;
    try {
      await service.assertDestinationsAllowed(
        USER,
        [DEST],
        { actorType: 'user' },
        { deferAudit: true },
      );
    } catch (err) {
      caught = err;
    }
    expect(isDeferredDestinationPolicyDenial(caught)).toBe(true);
    expect(record).not.toHaveBeenCalled();
    if (!isDeferredDestinationPolicyDenial(caught)) return;
    expect(caught.httpException).toBeInstanceOf(ServiceUnavailableException);
  });

  it('acquireUserDestinationLock uses advisory lock SQL', async () => {
    const tx = { $executeRaw: executeRaw };
    executeRaw.mockResolvedValue(undefined);
    await service.acquireUserDestinationLock(USER, tx as never);
    expect(executeRaw).toHaveBeenCalled();
  });
});
