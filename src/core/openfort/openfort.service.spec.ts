import { BadGatewayException, ConflictException, HttpStatus, Logger } from '@nestjs/common';

const backendCreate = jest.fn();
const mockHasCaliburDelegation = jest.fn();
const mockIsCaliburKeyRegistered = jest.fn();
const mockGetCaliburKeySettings = jest.fn();
const mockEstimateFeesPerGas = jest.fn();

jest.mock('@openfort/openfort-node', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    accounts: {
      evm: {
        backend: {
          create: backendCreate,
          get: jest.fn(),
          sendTransaction: jest.fn(),
          sign: jest.fn(),
        },
      },
    },
  })),
}));

jest.mock('../../common/calibur/calibur', () => {
  const actual = jest.requireActual('../../common/calibur/calibur');
  return {
    ...actual,
    hasCaliburDelegation: mockHasCaliburDelegation,
    isCaliburKeyRegistered: mockIsCaliburKeyRegistered,
    getCaliburKeySettings: mockGetCaliburKeySettings,
  };
});

jest.mock('viem/actions', () => ({
  ...jest.requireActual('viem/actions'),
  estimateFeesPerGas: mockEstimateFeesPerGas,
}));

import { OpenfortService } from './openfort.service';
import { RequestContextService } from '../../common/request-context/request-context.service';

describe('OpenfortService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEstimateFeesPerGas.mockResolvedValue({
      maxFeePerGas: 200_000_000_000n,
      maxPriorityFeePerGas: 178_000_000_000n,
    });
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('fails Openfort calls that exceed the configured timeout', async () => {
    backendCreate.mockReturnValue(new Promise(() => undefined));
    const configService = {
      getOrThrow: jest.fn(() => 'secret'),
      get: jest.fn(() => 25),
    };
    const service = new OpenfortService(configService as any);

    const promise = service.createBackendWallet();
    jest.advanceTimersByTime(25);

    await expect(promise).rejects.toThrow(BadGatewayException);
  });

  it('logs Openfort failures with requestId and operation context', async () => {
    const loggerErrorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    backendCreate.mockReturnValue(new Promise(() => undefined));
    const configService = {
      getOrThrow: jest.fn(() => 'secret'),
      get: jest.fn(() => 25),
    };
    const requestContext = new RequestContextService();
    const service = new OpenfortService(configService as any, requestContext);

    await requestContext.run({ requestId: 'req-openfort' }, async () => {
      const promise = service.createBackendWallet();
      jest.advanceTimersByTime(25);

      await expect(promise).rejects.toThrow(BadGatewayException);
    });

    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Openfort operation failed',
        requestId: 'req-openfort',
        operation: 'createBackendWallet',
      }),
      expect.any(String),
    );

    loggerErrorSpy.mockRestore();
  });

  it('reports pending agent registration when 7702 delegation is not active yet', async () => {
    mockHasCaliburDelegation.mockResolvedValue(false);
    const configService = {
      getOrThrow: jest.fn(() => 'secret'),
      get: jest.fn(() => 25),
    };
    const service = new OpenfortService(configService as any);

    await expect(
      service.verifyAgentKeyRegistration({
        accountAddress: '0x1111111111111111111111111111111111111111',
        chainId: 84532,
        keyHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
      }),
    ).rejects.toThrow(ConflictException);
    expect(mockIsCaliburKeyRegistered).not.toHaveBeenCalled();
  });

  it('creates a clear paymaster policy exception', () => {
    const configService = {
      getOrThrow: jest.fn(() => 'secret'),
      get: jest.fn(() => 25),
    };
    const service = new OpenfortService(configService as any) as any;

    const exception = service.createPaymasterPolicyException(137);

    expect(exception.getStatus()).toBe(HttpStatus.FAILED_DEPENDENCY);
    expect(exception.getResponse()).toEqual({
      code: 'PAYMASTER_POLICY_NOT_CONFIGURED',
      message: 'No gas sponsorship policy is configured for chainId 137.',
    });
  });

  it('falls back to an unsponsored UserOperation when auto sponsorship has no policy', async () => {
    const configService = {
      getOrThrow: jest.fn(() => 'secret'),
      get: jest.fn(() => 25),
    };
    const service = new OpenfortService(configService as any) as any;
    const sponsoredClient = {
      sendUserOperation: jest
        .fn()
        .mockRejectedValue(
          new Error('No matching project-scoped policy found for this transaction'),
        ),
    };
    const unsponsoredClient = {
      sendUserOperation: jest.fn().mockResolvedValue('0xuserop'),
    };
    jest
      .spyOn(service, 'createBundlerClient')
      .mockReturnValueOnce(sponsoredClient)
      .mockReturnValueOnce(unsponsoredClient);

    await expect(
      service.sendUserOperationWithSponsorship({
        account: {},
        chain: {},
        client: {},
        transport: {},
        interactions: [
          {
            to: '0x1111111111111111111111111111111111111111',
            data: '0x',
            value: '0',
          },
        ],
        sponsorshipMode: 'auto',
        chainId: 137,
        gasPrice: {
          maxFeePerGas: 200_000_000_000n,
          maxPriorityFeePerGas: 178_000_000_000n,
        },
      }),
    ).resolves.toEqual({ hash: '0xuserop', bundlerClient: unsponsoredClient });
    expect(sponsoredClient.sendUserOperation.mock.calls[0][0].maxFeePerGas.toString()).toBe(
      '200000000000',
    );
    expect(
      sponsoredClient.sendUserOperation.mock.calls[0][0].maxPriorityFeePerGas.toString(),
    ).toBe('178000000000');
    expect(unsponsoredClient.sendUserOperation.mock.calls[0][0].maxFeePerGas.toString()).toBe(
      '200000000000',
    );
    expect(
      unsponsoredClient.sendUserOperation.mock.calls[0][0].maxPriorityFeePerGas.toString(),
    ).toBe('178000000000');
    expect(service.createBundlerClient).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ includePaymaster: true }),
    );
    expect(service.createBundlerClient).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ includePaymaster: false }),
    );
  });

  it('uses standard chain fee estimation for UserOperation fees', async () => {
    const configService = {
      getOrThrow: jest.fn(() => 'secret'),
      get: jest.fn(() => 25),
    };
    const service = new OpenfortService(configService as any) as any;

    const gasPrice = await service.estimateUserOperationFees({ chain: { id: 137 } });

    expect(gasPrice.maxFeePerGas.toString()).toBe('200000000000');
    expect(gasPrice.maxPriorityFeePerGas.toString()).toBe('178000000000');
    expect(mockEstimateFeesPerGas).toHaveBeenCalledWith(
      expect.objectContaining({ chain: { id: 137 } }),
      { chain: { id: 137 }, type: 'eip1559' },
    );
  });

  it('maps UserOperation gas price failures to a specific API error', () => {
    const configService = {
      getOrThrow: jest.fn(() => 'secret'),
      get: jest.fn(() => 25),
    };
    const service = new OpenfortService(configService as any) as any;

    const exception = service.createOpenfortApiException(
      'sendUserOperation',
      new Error('Unable to estimate UserOperation fee parameters from chain RPC'),
    );

    expect(exception.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    expect(exception.getResponse()).toEqual({
      code: 'USER_OPERATION_GAS_PRICE_UNAVAILABLE',
      message: 'Unable to estimate UserOperation fee parameters from chain RPC.',
    });
  });

  it('maps bundler rejections to a specific sanitized API error', () => {
    const configService = {
      getOrThrow: jest.fn(() => 'secret'),
      get: jest.fn(() => 25),
    };
    const service = new OpenfortService(configService as any) as any;

    const exception = service.createOpenfortApiException('sendUserOperation', {
      message:
        'maxPriorityFeePerGas must be at least 178 gwei for calldata 0x1234567890abcdef1234567890abcdef1234567890abcdef',
    });

    expect(exception.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    expect(exception.getResponse()).toEqual({
      code: 'USER_OPERATION_REJECTED',
      message:
        'UserOperation rejected by bundler: gas price is below the required network minimum. Reason: maxPriorityFeePerGas must be at least 178 gwei for calldata [hex]',
    });
  });

  it('maps backend EOA send failures to a specific API error', () => {
    const configService = {
      getOrThrow: jest.fn(() => 'secret'),
      get: jest.fn(() => 25),
    };
    const service = new OpenfortService(configService as any) as any;

    const exception = service.createOpenfortApiException(
      'sendBackendTransaction',
      new Error('insufficient funds for gas'),
    );

    expect(exception.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    expect(exception.getResponse()).toEqual({
      code: 'BACKEND_TRANSACTION_FAILED',
      message:
        'Backend EOA transaction failed. Check chainId, target contract calldata, value, and wallet balance. Reason: insufficient funds for gas',
    });
  });
});
