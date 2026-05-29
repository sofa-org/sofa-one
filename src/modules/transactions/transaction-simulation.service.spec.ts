import { BadRequestException, Logger } from '@nestjs/common';

const mockCall = jest.fn();
const mockCreatePublicClient = jest.fn(() => ({ call: mockCall }));

jest.mock('viem', () => ({
  ...jest.requireActual('viem'),
  createPublicClient: () => mockCreatePublicClient(),
  getAddress: (address: string) => address,
  http: jest.fn(() => 'http-transport'),
}));

import { TransactionSimulationService } from './transaction-simulation.service';

describe('TransactionSimulationService', () => {
  const dto = {
    chainId: 8453,
    interactions: [{ to: '0x1111111111111111111111111111111111111111', data: '0x12345678', value: '0' }],
    idempotencyKey: 'idem-1',
  } as any;
  const context = {
    userId: 'user-1',
    apiKeyId: 'api-key-1',
    apiKeyPrefix: 'sk_1234567890abcdef12345678',
    chainId: 8453,
    executionMode: 'session_key' as const,
    from: '0x2222222222222222222222222222222222222222',
  };
  const securityEvents = { record: jest.fn() };
  let loggerWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCall.mockResolvedValue({ data: '0x' });
    loggerWarnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    loggerWarnSpy.mockRestore();
  });

  it('simulates every interaction and records an allow event', async () => {
    const service = new TransactionSimulationService(securityEvents as any);

    await expect(service.assertSimulatable(dto, context)).resolves.toBeUndefined();

    expect(mockCall).toHaveBeenCalledWith({
      account: context.from,
      to: dto.interactions[0].to,
      data: dto.interactions[0].data,
      value: 0n,
    });
    expect(securityEvents.record).toHaveBeenCalledWith({
      actorType: 'api_key',
      eventType: 'transaction.simulation_allowed',
      userId: 'user-1',
      apiKeyId: 'api-key-1',
      riskLevel: 'low',
      result: 'allowed',
      reason: 'simulation_passed',
      metadata: expect.objectContaining({
        chainId: 8453,
        executionMode: 'session_key',
        apiKeyPrefix: context.apiKeyPrefix,
        interactionCount: 1,
      }),
    });
  });

  it('rejects failed simulations without logging full calldata', async () => {
    const fullCalldata = `0x${'11'.repeat(64)}`;
    mockCall.mockRejectedValueOnce(new Error(`execution reverted with calldata ${fullCalldata}`));
    const service = new TransactionSimulationService(securityEvents as any);

    await expect(
      service.assertSimulatable(
        { ...dto, interactions: [{ ...dto.interactions[0], data: fullCalldata }] },
        context,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'security',
        message: 'Transaction simulation rejected request',
        reason: expect.stringContaining('[hex]'),
        interactionIndex: 0,
      }),
    );
    expect(securityEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'transaction.simulation_denied',
        result: 'denied',
        riskLevel: 'high',
        reason: expect.stringContaining('[hex]'),
        metadata: expect.objectContaining({ interactionIndex: 0 }),
      }),
    );
    expect(JSON.stringify(loggerWarnSpy.mock.calls)).not.toContain(fullCalldata);
    expect(JSON.stringify(securityEvents.record.mock.calls)).not.toContain(fullCalldata);
  });
});
