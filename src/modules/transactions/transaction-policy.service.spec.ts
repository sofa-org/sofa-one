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
  let loggerWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    service = new TransactionPolicyService();
    loggerWarnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    loggerWarnSpy.mockRestore();
  });

  it('allows benign interactions', () => {
    expect(() => service.assertAllowed(baseDto, context)).not.toThrow();
    expect(loggerWarnSpy).not.toHaveBeenCalled();
  });

  it('rejects more than ten interactions', () => {
    expect(() =>
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
    ).toThrow(BadRequestException);

    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'security',
        message: 'Transaction policy rejected request',
        reason: 'Transaction contains too many interactions; maximum is 10',
        interactionCount: 11,
      }),
    );
  });

  it('rejects native value transfers', () => {
    expect(() =>
      service.assertAllowed(
        { ...baseDto, interactions: [{ ...baseDto.interactions[0], value: '1' }] },
        context,
      ),
    ).toThrow('Native value transfers are not allowed for API key transactions');
  });

  it('rejects calldata that is too short to contain a full selector', () => {
    expect(() =>
      service.assertAllowed(
        { ...baseDto, interactions: [{ ...baseDto.interactions[0], data: '0x123456' }] },
        context,
      ),
    ).toThrow('Interaction 1 calldata is too short');
  });

  it.each(['0xd505accf', '0x8fcbaf0c', '0x2b67b570', '0xb7f13ed4', '0x002a3e3a'])(
    'rejects blocked permit selector %s',
    (selector) => {
      expect(() =>
        service.assertAllowed(
          { ...baseDto, interactions: [{ ...baseDto.interactions[0], data: selector }] },
          context,
        ),
      ).toThrow('Permit signatures are not allowed in transaction calldata');
    },
  );

  it('rejects max-uint ERC20 approvals without logging full calldata', () => {
    const calldata =
      '0x095ea7b3' +
      '000000000000000000000000e111180000d2663c0091e4f400237545b87b996b' +
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

    expect(() =>
      service.assertAllowed(
        { ...baseDto, interactions: [{ ...baseDto.interactions[0], data: calldata }] },
        context,
      ),
    ).toThrow('Infinite token approvals are not allowed');

    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'Infinite token approvals are not allowed',
        selector: '0x095ea7b3',
      }),
    );
    expect(JSON.stringify(loggerWarnSpy.mock.calls)).not.toContain(calldata);
  });

  it('rejects NFT approval-for-all grants', () => {
    const calldata =
      '0xa22cb465' +
      '000000000000000000000000e111180000d2663c0091e4f400237545b87b996b' +
      '0000000000000000000000000000000000000000000000000000000000000001';

    expect(() =>
      service.assertAllowed(
        { ...baseDto, interactions: [{ ...baseDto.interactions[0], data: calldata }] },
        context,
      ),
    ).toThrow('NFT operator approvals are not allowed');
  });
});
