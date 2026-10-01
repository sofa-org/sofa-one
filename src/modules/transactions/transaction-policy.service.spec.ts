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
  let loggerWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    securityEvents.record.mockResolvedValue(undefined);
    prisma.transaction.findMany.mockResolvedValue([]);
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

  it('rejects native value transfers', async () => {
    await expect(
      service.assertAllowed(
        { ...baseDto, interactions: [{ ...baseDto.interactions[0], value: '1' }] },
        context,
      ),
    ).rejects.toThrow('Native value transfers are not allowed for API key transactions');
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

  it('rejects max-uint ERC20 approvals without logging full calldata', async () => {
    const calldata =
      '0x095ea7b3' +
      '000000000000000000000000e111180000d2663c0091e4f400237545b87b996b' +
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

    await expect(
      service.assertAllowed(
        { ...baseDto, interactions: [{ ...baseDto.interactions[0], data: calldata }] },
        context,
      ),
    ).rejects.toThrow('Infinite token approvals are not allowed');

    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'Infinite token approvals are not allowed',
        selector: '0x095ea7b3',
      }),
    );
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

  // ── Spend limits ────────────────────────────────────────────────────

  it('allows transactions within daily spend limit', async () => {
    const spendContext = { ...context, dailySpendLimit: '1000000000000000000' }; // 1 ETH
    const dto: SendTransactionDto = {
      ...baseDto,
      interactions: [{ ...baseDto.interactions[0], value: '500000000000000000' }],
    };
    await expect(service.assertAllowed(dto, spendContext)).rejects.toThrow(
      'Native value transfers are not allowed',
    );
  });

  it('rejects transactions exceeding daily spend limit', async () => {
    const spendContext = { ...context, dailySpendLimit: '1000000000000000000' }; // 1 ETH
    const dto: SendTransactionDto = {
      ...baseDto,
      interactions: [{ ...baseDto.interactions[0], value: '2000000000000000000' }],
    };
    await expect(service.assertAllowed(dto, spendContext)).rejects.toThrow(
      'exceed daily spend limit',
    );
  });

  it('rejects transactions exceeding monthly spend limit', async () => {
    const spendContext = { ...context, monthlySpendLimit: '1000000000000000000' }; // 1 ETH
    const dto: SendTransactionDto = {
      ...baseDto,
      interactions: [{ ...baseDto.interactions[0], value: '2000000000000000000' }],
    };
    await expect(service.assertAllowed(dto, spendContext)).rejects.toThrow(
      'exceed monthly spend limit',
    );
  });

  it('sums values across multiple interactions for spend limit check', async () => {
    const spendContext = { ...context, dailySpendLimit: '1000000000000000000' }; // 1 ETH
    const dto: SendTransactionDto = {
      ...baseDto,
      interactions: [
        { ...baseDto.interactions[0], value: '600000000000000000' },
        { ...baseDto.interactions[0], value: '500000000000000000' },
      ],
    };
    await expect(service.assertAllowed(dto, spendContext)).rejects.toThrow(
      'exceed daily spend limit',
    );
  });

  it('skips spend limit check when limits are null/undefined', async () => {
    const spendContext = { ...context, dailySpendLimit: null, monthlySpendLimit: undefined };
    await expect(service.assertAllowed(baseDto, spendContext)).resolves.toBeUndefined();
  });

  // ── Cumulative spend limit tracking ─────────────────────────────────

  it('rejects when cumulative daily spending plus current value exceeds limit', async () => {
    prisma.transaction.findMany.mockResolvedValue([
      {
        details: { interactions: [{ value: '800000000000000000' }] },
      },
    ]);
    const spendContext = { ...context, dailySpendLimit: '1000000000000000000', apiKeyId: 'key-1' };
    const dto: SendTransactionDto = {
      ...baseDto,
      interactions: [{ ...baseDto.interactions[0], value: '300000000000000000' }],
    };
    await expect(service.assertAllowed(dto, spendContext)).rejects.toThrow(
      'exceed daily spend limit',
    );
    expect(prisma.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ apiKeyId: 'key-1' }),
      }),
    );
  });

  it('allows when cumulative daily spending plus current value is within limit', async () => {
    prisma.transaction.findMany.mockResolvedValue([
      {
        details: { interactions: [{ value: '400000000000000000' }] },
      },
    ]);
    const spendContext = { ...context, dailySpendLimit: '1000000000000000000', apiKeyId: 'key-1' };
    const dto: SendTransactionDto = {
      ...baseDto,
      interactions: [{ ...baseDto.interactions[0], value: '500000000000000000' }],
    };
    // 0.4 + 0.5 = 0.9 ETH < 1 ETH daily limit, but native value transfer is rejected
    await expect(service.assertAllowed(dto, spendContext)).rejects.toThrow(
      'Native value transfers are not allowed',
    );
  });

  it('rejects when cumulative monthly spending plus current value exceeds limit', async () => {
    prisma.transaction.findMany.mockResolvedValue([
      {
        details: { interactions: [{ value: '900000000000000000' }] },
      },
    ]);
    const spendContext = {
      ...context,
      monthlySpendLimit: '1000000000000000000',
      apiKeyId: 'key-1',
    };
    const dto: SendTransactionDto = {
      ...baseDto,
      interactions: [{ ...baseDto.interactions[0], value: '200000000000000000' }],
    };
    await expect(service.assertAllowed(dto, spendContext)).rejects.toThrow(
      'exceed monthly spend limit',
    );
  });

  it('queries past transactions for the correct time period (daily)', async () => {
    prisma.transaction.findMany.mockResolvedValue([]);
    const spendContext = { ...context, dailySpendLimit: '1000000000000000000', apiKeyId: 'key-1' };
    const dto: SendTransactionDto = {
      ...baseDto,
      interactions: [{ ...baseDto.interactions[0], value: '0' }],
    };
    await expect(service.assertAllowed(dto, spendContext)).resolves.toBeUndefined();
    const calls = prisma.transaction.findMany.mock.calls;
    const dailyCall = calls.find(
      (args: unknown[]) =>
        (args[0] as Record<string, unknown>)?.where &&
        (args[0] as { where: Record<string, unknown> }).where.createdAt &&
        typeof (args[0] as { where: { createdAt: Record<string, unknown> } }).where.createdAt
          .gte === 'object',
    );
    expect(dailyCall).toBeDefined();
    if (dailyCall) {
      const where = (dailyCall[0] as { where: Record<string, unknown> }).where;
      expect(where.apiKeyId).toBe('key-1');
      expect(where.status).toEqual({ in: ['submitting', 'pending', 'confirmed', 'unknown'] });
    }
  });

  it('handles missing apiKeyId gracefully in spend limit check', async () => {
    const spendContext = { ...context, dailySpendLimit: '1000000000000000000' };
    const dto: SendTransactionDto = {
      ...baseDto,
      interactions: [{ ...baseDto.interactions[0], value: '0' }],
    };
    // apiKeyId is undefined, getSpentInPeriod returns 0n immediately without querying
    await expect(service.assertAllowed(dto, spendContext)).resolves.toBeUndefined();
    // With no apiKeyId, the cumulative check skips the DB query
    expect(prisma.transaction.findMany).not.toHaveBeenCalled();
  });
});
