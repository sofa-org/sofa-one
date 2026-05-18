import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

const backendCreate = jest.fn();
const iamGetSession = jest.fn();
const accountsList = jest.fn();
const mockHasCaliburDelegation = jest.fn();
const mockIsCaliburKeyRegistered = jest.fn();
const mockGetCaliburKeySettings = jest.fn();
const mockEstimateFeesPerGas = jest.fn();
const mockGetTransactionReceipt = jest.fn();

jest.mock('@openfort/openfort-node', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    accounts: {
      list: accountsList,
      evm: {
        backend: {
          create: backendCreate,
          get: jest.fn(),
          sendTransaction: jest.fn(),
          sign: jest.fn(),
        },
      },
    },
    iam: {
      getSession: iamGetSession,
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
  getTransactionReceipt: mockGetTransactionReceipt,
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

  it('rejects IAM sessions without an Openfort user id', async () => {
    iamGetSession.mockResolvedValue({ user: { email: 'user@example.com' } });
    const configService = {
      getOrThrow: jest.fn(() => 'secret'),
      get: jest.fn(() => 25),
    };
    const service = new OpenfortService(configService as any);

    await expect(service.verifyIamSession('access-token')).rejects.toThrow(ForbiddenException);
  });

  it('maps IAM session lookup failures to BadGatewayException', async () => {
    iamGetSession.mockRejectedValue(new Error('Openfort unavailable'));
    const configService = {
      getOrThrow: jest.fn(() => 'secret'),
      get: jest.fn(() => 25),
    };
    const service = new OpenfortService(configService as any);

    await expect(service.verifyIamSession('access-token')).rejects.toThrow(BadGatewayException);
  });

  it('rejects embedded wallet addresses not owned by the Openfort user', async () => {
    iamGetSession.mockResolvedValue({ user: { id: 'ofu_123' } });
    accountsList.mockResolvedValue({
      data: [
        {
          id: 'acc_other',
          address: '0x2222222222222222222222222222222222222222',
        },
      ],
    });
    const configService = {
      getOrThrow: jest.fn(() => 'secret'),
      get: jest.fn(() => 25),
    };
    const service = new OpenfortService(configService as any);

    await expect(
      service.authorizeEmbeddedAddress(
        'access-token',
        '0x1111111111111111111111111111111111111111',
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(accountsList).toHaveBeenCalledWith({ user: 'ofu_123' });
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

  it('uses paymaster only when sponsorship is required', async () => {
    const configService = {
      getOrThrow: jest.fn(() => 'secret'),
      get: jest.fn(() => 25),
    };
    const service = new OpenfortService(configService as any) as any;
    const sponsoredClient = { sendUserOperation: jest.fn().mockResolvedValue('0xuserop') };
    jest.spyOn(service, 'createBundlerClient').mockReturnValueOnce(sponsoredClient);

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
        sponsorshipMode: 'required',
        chainId: 137,
        gasPrice: {
          maxFeePerGas: 200_000_000_000n,
          maxPriorityFeePerGas: 178_000_000_000n,
        },
      }),
    ).resolves.toEqual({ hash: '0xuserop', bundlerClient: sponsoredClient });
    expect(sponsoredClient.sendUserOperation.mock.calls[0][0].maxFeePerGas.toString()).toBe(
      '200000000000',
    );
    expect(
      sponsoredClient.sendUserOperation.mock.calls[0][0].maxPriorityFeePerGas.toString(),
    ).toBe('178000000000');
    expect(service.createBundlerClient).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ includePaymaster: true }),
    );
  });

  it('skips paymaster when sponsorship is none', async () => {
    const configService = {
      getOrThrow: jest.fn(() => 'secret'),
      get: jest.fn(() => 25),
    };
    const service = new OpenfortService(configService as any) as any;
    const unsponsoredClient = {
      estimateUserOperationGas: jest.fn().mockResolvedValue({
        callGasLimit: 100_000n,
        verificationGasLimit: 200_000n,
        preVerificationGas: 30_000n,
        paymasterPostOpGasLimit: 0n,
        paymasterVerificationGasLimit: 0n,
      }),
      sendUserOperation: jest.fn().mockResolvedValue('0xuserop'),
    };
    jest.spyOn(service, 'createBundlerClient').mockReturnValueOnce(unsponsoredClient);

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
        sponsorshipMode: 'none',
        chainId: 137,
        gasPrice: {
          maxFeePerGas: 200_000_000_000n,
          maxPriorityFeePerGas: 178_000_000_000n,
        },
      }),
    ).resolves.toEqual({ hash: '0xuserop', bundlerClient: unsponsoredClient });
    expect(service.createBundlerClient).toHaveBeenCalledWith(
      expect.objectContaining({ includePaymaster: false }),
    );
    expect(unsponsoredClient.estimateUserOperationGas).toHaveBeenCalledWith(
      expect.objectContaining({
        account: {},
        maxFeePerGas: 200_000_000_000n,
        maxPriorityFeePerGas: 178_000_000_000n,
      }),
    );
    expect(unsponsoredClient.sendUserOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        callGasLimit: 100_000n,
        verificationGasLimit: 200_000n,
        preVerificationGas: 30_000n,
        maxFeePerGas: 200_000_000_000n,
        maxPriorityFeePerGas: 178_000_000_000n,
      }),
    );
    expect(unsponsoredClient.sendUserOperation.mock.calls[0][0]).not.toHaveProperty(
      'paymasterPostOpGasLimit',
    );
    expect(unsponsoredClient.sendUserOperation.mock.calls[0][0]).not.toHaveProperty(
      'paymasterVerificationGasLimit',
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

  it('returns null when a transaction receipt is not found yet', async () => {
    mockGetTransactionReceipt.mockRejectedValue(new Error('Transaction receipt not found'));
    const configService = {
      getOrThrow: jest.fn(() => 'secret'),
      get: jest.fn(() => 25),
    };
    const service = new OpenfortService(configService as any);

    await expect(
      service.getTransactionReceiptStatus(
        84532,
        '0x1111111111111111111111111111111111111111111111111111111111111111',
      ),
    ).resolves.toBeNull();
  });

  it('maps unexpected receipt lookup failures to BadGatewayException', async () => {
    const loggerErrorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    mockGetTransactionReceipt.mockRejectedValue(new Error('RPC connection failed'));
    const configService = {
      getOrThrow: jest.fn(() => 'secret'),
      get: jest.fn(() => 25),
    };
    const service = new OpenfortService(configService as any);

    await expect(
      service.getTransactionReceiptStatus(
        84532,
        '0x1111111111111111111111111111111111111111111111111111111111111111',
      ),
    ).rejects.toThrow(BadGatewayException);

    loggerErrorSpy.mockRestore();
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

  it('does not classify generic maxFeePerGas invalid-field errors as gas-price minimum failures', () => {
    const configService = {
      getOrThrow: jest.fn(() => 'secret'),
      get: jest.fn(() => 25),
    };
    const service = new OpenfortService(configService as any) as any;

    const exception = service.createOpenfortApiException('sendUserOperation', {
      message:
        'Invalid fields: paymasterPostOpGasLimit is present without paymaster; maxFeePerGas=0x1234',
    });

    expect(exception.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    expect(exception.getResponse()).toEqual({
      code: 'USER_OPERATION_REJECTED',
      message:
        'UserOperation rejected by bundler. Check chainId, target contract calldata, value, gas sponsorship, and session key authorization. Reason: Invalid fields: paymasterPostOpGasLimit is present without paymaster; maxFeePerGas=0x1234',
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
