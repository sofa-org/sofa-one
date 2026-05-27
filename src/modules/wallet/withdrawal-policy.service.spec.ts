import { BadRequestException, Logger } from '@nestjs/common';
import { WithdrawalPolicyService } from './withdrawal-policy.service';
import { PrismaService } from '../../core/database/prisma.service';
import type { WithdrawDto } from './dto/withdraw.dto';

const VALID_DTO: WithdrawDto = {
  chainId: 84532,
  to: '0x1111111111111111111111111111111111111111',
  amount: '1000000',
  token: 'USDC',
  idempotencyKey: 'idem-key-123',
};

describe('WithdrawalPolicyService', () => {
  let service: WithdrawalPolicyService;
  const mockWithdrawalPolicyFindUnique = jest.fn();
  const mockWithdrawalPolicyUpsert = jest.fn();
  const mockWithdrawalAddressFindUnique = jest.fn();
  const mockWithdrawalAddressFindMany = jest.fn();
  const mockWithdrawalAddressCreate = jest.fn();
  const mockWithdrawalAddressDeleteMany = jest.fn();
  const mockTransactionFindMany = jest.fn();
  const securityEvents = { record: jest.fn() };
  let loggerWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    securityEvents.record.mockResolvedValue(undefined);
    loggerWarnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    mockWithdrawalPolicyFindUnique.mockResolvedValue(null);
    mockWithdrawalPolicyUpsert.mockResolvedValue({
      id: 'policy-1',
      requireAddressAllowlist: true,
      newAddressCooldownHours: 24,
    });
    mockWithdrawalAddressFindUnique.mockResolvedValue(null);
    mockWithdrawalAddressFindMany.mockResolvedValue([]);
    mockWithdrawalAddressCreate.mockImplementation(({ data }) => ({
      id: 'addr-1',
      ...data,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }));
    mockWithdrawalAddressDeleteMany.mockResolvedValue({ count: 1 });
    mockTransactionFindMany.mockResolvedValue([]);

    service = new WithdrawalPolicyService(
      {
        withdrawalPolicy: { findUnique: mockWithdrawalPolicyFindUnique, upsert: mockWithdrawalPolicyUpsert },
        withdrawalAddress: {
          findUnique: mockWithdrawalAddressFindUnique,
          findMany: mockWithdrawalAddressFindMany,
          create: mockWithdrawalAddressCreate,
          deleteMany: mockWithdrawalAddressDeleteMany,
        },
        transaction: { findMany: mockTransactionFindMany },
      } as unknown as PrismaService,
      securityEvents as never,
    );
  });

  afterEach(() => {
    loggerWarnSpy.mockRestore();
  });

  it('allows withdrawals under the default single-withdrawal limit without a custom policy', async () => {
    await expect(
      service.assertWithdrawalAllowed('user-1', VALID_DTO, { chainId: VALID_DTO.chainId }),
    ).resolves.toBeUndefined();

    expect(mockWithdrawalPolicyFindUnique).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(mockTransactionFindMany).not.toHaveBeenCalled();
    expect(mockWithdrawalAddressFindUnique).not.toHaveBeenCalled();
  });

  it('rejects withdrawals above the configured single-withdrawal limit', async () => {
    mockWithdrawalPolicyFindUnique.mockResolvedValue({
      id: 'policy-1',
      singleWithdrawalLimit: '500000',
      dailyWithdrawalLimit: null,
      requireAddressAllowlist: false,
      newAddressCooldownHours: 24,
      requireStepUp: true,
    });

    await expect(
      service.assertWithdrawalAllowed('user-1', VALID_DTO, { chainId: VALID_DTO.chainId }),
    ).rejects.toThrow('Withdrawal amount exceeds single-withdrawal limit');

    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'security',
        message: 'Withdrawal policy rejected request',
        reason: 'Withdrawal amount exceeds single-withdrawal limit',
        maxAmountUnits: '500000',
        policyId: 'policy-1',
      }),
    );
    expect(securityEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'user',
        eventType: 'withdrawal.policy_denied',
        userId: 'user-1',
        riskLevel: 'high',
        result: 'denied',
        reason: 'Withdrawal amount exceeds single-withdrawal limit',
      }),
    );
  });

  it('rejects withdrawals that exceed the configured daily limit', async () => {
    mockWithdrawalPolicyFindUnique.mockResolvedValue({
      id: 'policy-1',
      singleWithdrawalLimit: '10000000',
      dailyWithdrawalLimit: '2000000',
      requireAddressAllowlist: false,
      newAddressCooldownHours: 24,
      requireStepUp: true,
    });
    mockTransactionFindMany.mockResolvedValue([
      { details: { amount: '1250000' } },
      { details: { amount: '250000' } },
    ]);

    await expect(
      service.assertWithdrawalAllowed('user-1', VALID_DTO, { chainId: VALID_DTO.chainId }),
    ).rejects.toThrow('Withdrawal amount exceeds daily withdrawal limit');

    expect(mockTransactionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-1',
          operationType: 'withdraw',
          chainId: BigInt(VALID_DTO.chainId),
          status: { in: ['submitting', 'pending', 'confirmed', 'unknown'] },
        }),
        select: { details: true },
      }),
    );
  });

  it('rejects non-allowlisted withdrawal addresses when allowlist is required', async () => {
    mockWithdrawalPolicyFindUnique.mockResolvedValue({
      id: 'policy-1',
      singleWithdrawalLimit: '10000000',
      dailyWithdrawalLimit: null,
      requireAddressAllowlist: true,
      newAddressCooldownHours: 24,
      requireStepUp: true,
    });

    await expect(
      service.assertWithdrawalAllowed('user-1', VALID_DTO, { chainId: VALID_DTO.chainId }),
    ).rejects.toThrow('Withdrawal address is not allowlisted');

    expect(mockWithdrawalAddressFindUnique).toHaveBeenCalledWith({
      where: { userId_address: { userId: 'user-1', address: VALID_DTO.to.toLowerCase() } },
    });
  });

  it('rejects allowlisted addresses until cooldown has elapsed', async () => {
    mockWithdrawalPolicyFindUnique.mockResolvedValue({
      id: 'policy-1',
      singleWithdrawalLimit: '10000000',
      dailyWithdrawalLimit: null,
      requireAddressAllowlist: true,
      newAddressCooldownHours: 24,
      requireStepUp: true,
    });
    mockWithdrawalAddressFindUnique.mockResolvedValue({
      address: VALID_DTO.to.toLowerCase(),
      availableAt: new Date(Date.now() + 60_000),
    });

    await expect(
      service.assertWithdrawalAllowed('user-1', VALID_DTO, { chainId: VALID_DTO.chainId }),
    ).rejects.toThrow('Withdrawal address is still in cooldown');
  });

  it('allows an allowlisted address after cooldown and logs high-value withdrawals', async () => {
    mockWithdrawalPolicyFindUnique.mockResolvedValue({
      id: 'policy-1',
      singleWithdrawalLimit: '10000000000',
      dailyWithdrawalLimit: null,
      requireAddressAllowlist: true,
      newAddressCooldownHours: 24,
      requireStepUp: true,
    });
    mockWithdrawalAddressFindUnique.mockResolvedValue({
      address: VALID_DTO.to.toLowerCase(),
      availableAt: new Date(Date.now() - 60_000),
    });

    await expect(
      service.assertWithdrawalAllowed(
        'user-1',
        { ...VALID_DTO, amount: '1000000000' },
        { chainId: VALID_DTO.chainId },
      ),
    ).resolves.toBeUndefined();

    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'security',
        message: 'High-value withdrawal requested',
        thresholdUnits: '1000000000',
        policyId: 'policy-1',
      }),
    );
    expect(securityEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'user',
        eventType: 'withdrawal.high_value_requested',
        userId: 'user-1',
        riskLevel: 'high',
        result: 'allowed',
        reason: 'high_value_withdrawal',
      }),
    );
  });

  it('rejects invalid policy limits explicitly', async () => {
    mockWithdrawalPolicyFindUnique.mockResolvedValue({
      id: 'policy-1',
      singleWithdrawalLimit: '0',
      dailyWithdrawalLimit: null,
      requireAddressAllowlist: false,
      newAddressCooldownHours: 24,
      requireStepUp: true,
    });

    await expect(
      service.assertWithdrawalAllowed('user-1', VALID_DTO, { chainId: VALID_DTO.chainId }),
    ).rejects.toThrow(BadRequestException);
  });

  it('lists withdrawal addresses with policy cooldown metadata', async () => {
    const availableAt = new Date(Date.now() - 60_000);
    mockWithdrawalPolicyFindUnique.mockResolvedValue({
      id: 'policy-1',
      singleWithdrawalLimit: '10000000000',
      dailyWithdrawalLimit: null,
      requireAddressAllowlist: true,
      newAddressCooldownHours: 24,
      requireStepUp: true,
    });
    mockWithdrawalAddressFindMany.mockResolvedValue([
      {
        id: 'addr-1',
        address: VALID_DTO.to.toLowerCase(),
        label: 'Treasury',
        availableAt,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);

    const result = await service.listWithdrawalAddresses('user-1');

    expect(mockWithdrawalAddressFindMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      orderBy: { createdAt: 'desc' },
    });
    expect(result.policy).toEqual({ requireAddressAllowlist: true, newAddressCooldownHours: 24 });
    expect(result.addresses[0]).toEqual(
      expect.objectContaining({
        id: 'addr-1',
        address: VALID_DTO.to.toLowerCase(),
        label: 'Treasury',
        isAvailable: true,
      }),
    );
  });

  it('adds a withdrawal address, enables allowlist policy, and applies cooldown', async () => {
    const before = Date.now();

    const result = await service.addWithdrawalAddress('user-1', {
      address: '0x1111111111111111111111111111111111111111',
      label: ' Treasury ',
    });

    expect(mockWithdrawalPolicyUpsert).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      update: { requireAddressAllowlist: true },
      create: { userId: 'user-1', requireAddressAllowlist: true },
    });
    expect(mockWithdrawalAddressCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        address: VALID_DTO.to.toLowerCase(),
        label: 'Treasury',
      }),
    });
    const availableAt = mockWithdrawalAddressCreate.mock.calls[0][0].data.availableAt as Date;
    expect(availableAt.getTime()).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000 - 1000);
    expect(result).toEqual(
      expect.objectContaining({
        id: 'addr-1',
        address: VALID_DTO.to.toLowerCase(),
        label: 'Treasury',
        isAvailable: false,
      }),
    );
    expect(securityEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'user',
        eventType: 'withdrawal_address.added',
        userId: 'user-1',
        riskLevel: 'medium',
        result: 'allowed',
        reason: 'withdrawal_address_added',
      }),
    );
  });

  it('rejects duplicate withdrawal addresses', async () => {
    mockWithdrawalAddressCreate.mockRejectedValue({ code: 'P2002' });

    await expect(
      service.addWithdrawalAddress('user-1', { address: VALID_DTO.to }),
    ).rejects.toThrow('Withdrawal address is already allowlisted');
  });

  it('removes a withdrawal address owned by the user', async () => {
    await expect(service.removeWithdrawalAddress('user-1', 'addr-1')).resolves.toEqual({ success: true });

    expect(mockWithdrawalAddressDeleteMany).toHaveBeenCalledWith({
      where: { id: 'addr-1', userId: 'user-1' },
    });
    expect(securityEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'user',
        eventType: 'withdrawal_address.removed',
        userId: 'user-1',
        riskLevel: 'medium',
        result: 'allowed',
        reason: 'withdrawal_address_removed',
      }),
    );
  });

  it('rejects removing a missing withdrawal address', async () => {
    mockWithdrawalAddressDeleteMany.mockResolvedValue({ count: 0 });

    await expect(service.removeWithdrawalAddress('user-1', 'addr-1')).rejects.toThrow(
      'Withdrawal address not found',
    );
  });
});
