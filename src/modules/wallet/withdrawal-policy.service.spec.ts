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
  const mockWithdrawalAddressFindUnique = jest.fn();
  const mockTransactionFindMany = jest.fn();
  let loggerWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    loggerWarnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    mockWithdrawalPolicyFindUnique.mockResolvedValue(null);
    mockWithdrawalAddressFindUnique.mockResolvedValue(null);
    mockTransactionFindMany.mockResolvedValue([]);

    service = new WithdrawalPolicyService({
      withdrawalPolicy: { findUnique: mockWithdrawalPolicyFindUnique },
      withdrawalAddress: { findUnique: mockWithdrawalAddressFindUnique },
      transaction: { findMany: mockTransactionFindMany },
    } as unknown as PrismaService);
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
});
