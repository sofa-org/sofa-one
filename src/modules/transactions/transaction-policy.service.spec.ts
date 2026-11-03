import { BadRequestException, Logger } from '@nestjs/common';
import { TransactionPolicyService } from './transaction-policy.service';
import type { SendTransactionDto } from './dto/send-transaction.dto';

describe('TransactionPolicyService', () => {
  const context = {
    userId: 'user-1',
    chainId: 8453,
    executionMode: 'session_key' as const,
    apiKeyPrefix: 'sk_1234567890abcdef12345678',
  };

  const baseDto: SendTransactionDto = {
    chainId: 8453,
    interactions: [{ to: '0x1111111111111111111111111111111111111111', data: '0x', value: '0' }],
    idempotencyKey: 'idem-1',
  };

  let service: TransactionPolicyService;
  const securityEvents = { record: jest.fn() };
  const prisma = {
    transaction: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const acceptanceTx = {
    apiKey: { findUnique: jest.fn() },
    transaction: { findMany: jest.fn() },
  };
  let loggerWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    securityEvents.record.mockResolvedValue(undefined);
    prisma.transaction.findMany.mockResolvedValue([]);
    acceptanceTx.apiKey.findUnique.mockResolvedValue({ userId: 'user-1', dailySpendLimit: null, monthlySpendLimit: null });
    acceptanceTx.transaction.findMany.mockResolvedValue([]);
    service = new TransactionPolicyService(prisma as never, securityEvents as never);
    loggerWarnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    loggerWarnSpy.mockRestore();
  });

  it('allows benign interactions', async () => {
    await expect(service.assertAllowed(baseDto, context)).resolves.toBeUndefined();
    expect(loggerWarnSpy).not.toHaveBeenCalled();
    expect(securityEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'api_key',
        eventType: 'transaction.policy_allowed',
        userId: 'user-1',
        riskLevel: 'low',
        result: 'allowed',
        reason: 'transaction_policy_allowed',
        metadata: expect.objectContaining({
          chainId: 8453,
          executionMode: 'session_key',
          interactionCount: 1,
          distinctTargetCount: 1,
          totalCalldataBytes: 0,
        }),
      }),
    );
  });

  it('rejects more than ten interactions', async () => {
    await expect(
      service.assertAllowed(
        {
          ...baseDto,
          interactions: Array.from({ length: 11 }, (_, index) => ({
            ...baseDto.interactions[0],
            to: `0x${String(index + 1).padStart(40, '0')}`,
          })),
        },
        context,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'security',
        message: 'Transaction policy rejected request',
        reason: 'Transaction contains too many interactions; maximum is 10',
        interactionCount: 11,
      }),
    );
    expect(securityEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'api_key',
        eventType: 'transaction.policy_denied',
        userId: 'user-1',
        riskLevel: 'high',
        result: 'denied',
        reason: 'Transaction contains too many interactions; maximum is 10',
      }),
    );
  });

  it('allows native value calls when structural and configured spend limits permit', async () => {
    await expect(service.assertAllowed(
      { ...baseDto, interactions: [{ ...baseDto.interactions[0], value: '1' }] }, context,
    )).resolves.toBeUndefined();
  });

  it('rejects calldata that is too short to contain a full selector', async () => {
    await expect(
      service.assertAllowed(
        { ...baseDto, interactions: [{ ...baseDto.interactions[0], data: '0x123456' }] },
        context,
      ),
    ).rejects.toThrow('Interaction 1 calldata is too short');
  });

  it('rejects aggregate calldata larger than 64 KB without logging full calldata', async () => {
    const largeCalldata = `0x${'11'.repeat(33 * 1024)}`;

    await expect(
      service.assertAllowed(
        {
          ...baseDto,
          interactions: [
            { ...baseDto.interactions[0], data: largeCalldata },
            { ...baseDto.interactions[0], data: largeCalldata },
          ],
        },
        context,
      ),
    ).rejects.toThrow('Transaction calldata exceeds maximum total size of 64 KB');

    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'Transaction calldata exceeds maximum total size of 64 KB',
        interactionCount: 2,
        totalCalldataBytes: 67584,
      }),
    );
    expect(JSON.stringify(loggerWarnSpy.mock.calls)).not.toContain(largeCalldata);
    expect(JSON.stringify(securityEvents.record.mock.calls)).not.toContain(largeCalldata);
  });

  it('rejects batches that target too many distinct contracts', async () => {
    await expect(
      service.assertAllowed(
        {
          ...baseDto,
          interactions: Array.from({ length: 6 }, (_, index) => ({
            ...baseDto.interactions[0],
            to: `0x${String(index + 1).padStart(40, '0')}`,
          })),
        },
        context,
      ),
    ).rejects.toThrow('Transaction targets too many distinct contracts');

    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'Transaction targets too many distinct contracts',
        interactionCount: 6,
        distinctTargetCount: 6,
      }),
    );
  });

  it.each(['0xd505accf', '0x8fcbaf0c', '0x2b67b570', '0xb7f13ed4', '0x002a3e3a'])(
    'rejects blocked permit selector %s',
    async (selector) => {
      await expect(
        service.assertAllowed(
          { ...baseDto, interactions: [{ ...baseDto.interactions[0], data: selector }] },
          context,
        ),
      ).rejects.toThrow('Permit signatures are not allowed in transaction calldata');
    },
  );

  it('allows unlimited ERC20 approvals without changing safe audit behavior', async () => {
    const calldata =
      '0x095ea7b3' +
      '000000000000000000000000e111180000d2663c0091e4f400237545b87b996b' +
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

    await expect(service.assertAllowed(
      { ...baseDto, interactions: [{ ...baseDto.interactions[0], data: calldata }] }, context,
    )).resolves.toBeUndefined();
    expect(JSON.stringify(loggerWarnSpy.mock.calls)).not.toContain(calldata);
    expect(JSON.stringify(securityEvents.record.mock.calls)).not.toContain(calldata);
  });

  it('rejects NFT approval-for-all grants', async () => {
    const calldata =
      '0xa22cb465' +
      '000000000000000000000000e111180000d2663c0091e4f400237545b87b996b' +
      '0000000000000000000000000000000000000000000000000000000000000001';

    await expect(
      service.assertAllowed(
        { ...baseDto, interactions: [{ ...baseDto.interactions[0], data: calldata }] },
        context,
      ),
    ).rejects.toThrow('NFT operator approvals are not allowed');
  });

  it('leaves user budget decisions to the locked acceptance transaction', async () => {
    await expect(service.assertAllowed({
      ...baseDto,
      interactions: [{ ...baseDto.interactions[0], value: '100000000000000000000000000000000000000' }],
    }, { ...context, dailySpendLimit: '0', apiKeyId: 'key-1' })).resolves.toBeUndefined();
    expect(prisma.transaction.findMany).not.toHaveBeenCalled();
  });

  const acceptedAt = new Date('2026-10-02T13:45:00.000Z');
  const checkBudget = (nativeValueWei: string) => service.assertSpendAllowedInTx(acceptanceTx as never, {
    userId: 'user-1', apiKeyId: 'key-1', nativeValueWei, acceptedAt,
  });

  it('enforces daily and monthly budgets at exact equality using UTC acceptance time', async () => {
    acceptanceTx.apiKey.findUnique.mockResolvedValue({ userId: 'user-1', dailySpendLimit: '100', monthlySpendLimit: '100' });
    acceptanceTx.transaction.findMany.mockResolvedValue([{ details: { nativeValueWei: '40' } }]);
    await expect(checkBudget('60')).resolves.toBeUndefined();
    expect(acceptanceTx.transaction.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ apiKeyId: 'key-1', status: { in: ['submitting', 'pending', 'confirmed', 'unknown', 'needs_review'] }, createdAt: { gte: new Date('2026-10-02T00:00:00.000Z'), lt: new Date('2026-10-03T00:00:00.000Z') } }),
    }));
  });

  it('uses the UTC month boundary and sums aggregate scalar values beyond uint256 safely', async () => {
    const aboveUint256 = ((1n << 256n) + 5n).toString();
    acceptanceTx.apiKey.findUnique.mockResolvedValue({ userId: 'user-1', dailySpendLimit: null, monthlySpendLimit: (BigInt(aboveUint256) + 10n).toString() });
    acceptanceTx.transaction.findMany.mockResolvedValue([{ details: { nativeValueWei: aboveUint256 } }]);
    await expect(checkBudget('10')).resolves.toBeUndefined();
    expect(acceptanceTx.transaction.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ apiKeyId: 'key-1', createdAt: { gte: new Date('2026-10-01T00:00:00.000Z'), lt: new Date('2026-11-01T00:00:00.000Z') } }),
    }));
  });

  it('treats zero as a configured limit, while null remains unlimited', async () => {
    acceptanceTx.apiKey.findUnique.mockResolvedValue({ userId: 'user-1', dailySpendLimit: '0', monthlySpendLimit: null });
    acceptanceTx.transaction.findMany.mockResolvedValue([]);
    await expect(checkBudget('0')).resolves.toBeUndefined();
    await expect(checkBudget('1')).rejects.toThrow('exceed daily spend limit');
    acceptanceTx.apiKey.findUnique.mockResolvedValue({ userId: 'user-1', dailySpendLimit: null, monthlySpendLimit: null });
    await expect(checkBudget('100000000000000000000')).resolves.toBeUndefined();
  });

  it('reads the persisted scalar first and falls back to legacy interaction values only when absent', async () => {
    acceptanceTx.apiKey.findUnique.mockResolvedValue({ userId: 'user-1', dailySpendLimit: '11', monthlySpendLimit: null });
    acceptanceTx.transaction.findMany.mockResolvedValue([
      { details: { nativeValueWei: '3', interactions: [{ value: '9' }] } },
      { details: { interactions: [{ value: '4' }, { value: '3' }] } },
      { details: { interactions: [{}] } },
    ]);
    await expect(checkBudget('1')).resolves.toBeUndefined();
    acceptanceTx.transaction.findMany.mockResolvedValue([{ details: { nativeValueWei: 'bad', interactions: [] } }]);
    await expect(checkBudget('0')).rejects.toThrow('API-key spend budget history unavailable');
  });
});
