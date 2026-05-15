import { BadGatewayException, ConflictException, HttpStatus, Logger } from '@nestjs/common';

const backendCreate = jest.fn();
const mockHasCaliburDelegation = jest.fn();
const mockIsCaliburKeyRegistered = jest.fn();
const mockGetCaliburKeySettings = jest.fn();

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

import { OpenfortService } from './openfort.service';
import { RequestContextService } from '../../common/request-context/request-context.service';

describe('OpenfortService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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

  it('uses bundler-recommended UserOperation gas prices', async () => {
    const configService = {
      getOrThrow: jest.fn(() => 'secret'),
      get: jest.fn(() => 25),
    };
    const service = new OpenfortService(configService as any) as any;
    const fetchSpy = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        result: {
          fast: {
            maxFeePerGas: '0x2e90edd000',
            maxPriorityFeePerGas: '0x2971a07400',
          },
        },
      }),
    } as any);

    const gasPrice = await service.getRecommendedUserOperationGasPrice({
      rpcUrl: 'https://api.openfort.io/rpc/137',
      publishableKey: 'pk_test',
    });
    expect(gasPrice.maxFeePerGas.toString()).toBe('200000000000');
    expect(gasPrice.maxPriorityFeePerGas.toString()).toBe('178000000000');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.openfort.io/rpc/137',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer pk_test' }),
      }),
    );

    fetchSpy.mockRestore();
  });
});
