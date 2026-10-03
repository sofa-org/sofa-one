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
const mockGetTransactionReceipt = jest.fn();
const mockGetBlock = jest.fn();
const mockGetCode = jest.fn();
const originalFetch = globalThis.fetch;
const mockFetch = jest.fn();

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
  getCode: mockGetCode,
  getTransactionReceipt: mockGetTransactionReceipt,
  getBlock: mockGetBlock,
}));

import { OpenfortService } from './openfort.service';
import { RequestContextService } from '../../common/request-context/request-context.service';

describe('OpenfortService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (globalThis as any).fetch = mockFetch;
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        jsonrpc: '2.0',
        id: 1,
        result: {
          standard: {
            maxFeePerGas: '200000000000',
            maxPriorityFeePerGas: '178000000000',
          },
          fast: {
            maxFeePerGas: '250000000000',
            maxPriorityFeePerGas: '178000000000',
          },
        },
      }),
    });
    jest.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
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
      total: 1,
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
    expect(accountsList).toHaveBeenCalledWith({ user: 'ofu_123', limit: 100, skip: 0 });
  });

  it('finds owned embedded addresses on later pages and ignores client account ids', async () => {
    iamGetSession.mockResolvedValue({ user: { id: 'ofu_123' } });
    accountsList.mockResolvedValueOnce({ data: Array.from({ length: 100 }, (_, i) => ({ id: `acc_${i}`, address: '0x2222222222222222222222222222222222222222' })), total: 101 })
      .mockResolvedValueOnce({ data: [{ id: 'server-account', address: '0x1111111111111111111111111111111111111111' }], total: 101 });
    const service = new OpenfortService({ getOrThrow: () => 'secret', get: () => 1000 } as any);
    await expect(service.authorizeEmbeddedAddress('token', '0x1111111111111111111111111111111111111111'))
      .resolves.toMatchObject({ accountId: 'server-account' });
    expect(accountsList).toHaveBeenNthCalledWith(2, { user: 'ofu_123', limit: 100, skip: 100 });
  });

  it.each([
    ['missing matching account id', { data: [{ address: '0x1111111111111111111111111111111111111111' }], total: 1 }],
    ['malformed page', { data: 'not-an-array', total: 1 }],
    ['truncated page', { data: [], total: 1 }],
  ])('fails closed for %s', async (_label, response) => {
    iamGetSession.mockResolvedValue({ user: { id: 'ofu_123' } });
    accountsList.mockResolvedValue(response);
    const service = new OpenfortService({ getOrThrow: () => 'secret', get: () => 1000 } as any);
    await expect(service.authorizeEmbeddedAddress('token', '0x1111111111111111111111111111111111111111'))
      .rejects.toThrow(BadGatewayException);
  });

  it('fails closed when pagination repeats entries', async () => {
    iamGetSession.mockResolvedValue({ user: { id: 'ofu_123' } });
    const page = Array.from({ length: 100 }, (_, i) => ({ id: `acc_${i}`, address: '0x2222222222222222222222222222222222222222' }));
    accountsList.mockResolvedValueOnce({ data: page, total: 101 }).mockResolvedValueOnce({ data: page, total: 101 });
    const service = new OpenfortService({ getOrThrow: () => 'secret', get: () => 1000 } as any);
    await expect(service.authorizeEmbeddedAddress('token', '0x1111111111111111111111111111111111111111'))
      .rejects.toThrow(BadGatewayException);
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
    expect(sponsoredClient.sendUserOperation.mock.calls[0][0].maxPriorityFeePerGas.toString()).toBe(
      '178000000000',
    );
    expect(service.createBundlerClient).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ includePaymaster: true }),
    );
  });

  it('times out the actual final UserOperation submission without retrying', async () => {
    const configService = {
      getOrThrow: jest.fn(() => 'secret'),
      get: jest.fn(() => 25),
    };
    const service = new OpenfortService(configService as any) as any;
    const sendUserOperation = jest.fn().mockReturnValue(new Promise(() => undefined));
    const client = { sendUserOperation };
    jest.spyOn(service, 'createBundlerClient').mockReturnValue(client);

    const promise = service.sendUserOperationWithSponsorship({
      account: {},
      chain: {},
      client: {},
      transport: {},
      interactions: [{ to: '0x1111111111111111111111111111111111111111', data: '0x', value: '0' }],
      sponsorshipMode: 'required',
      chainId: 137,
      gasPrice: { maxFeePerGas: 200_000_000_000n, maxPriorityFeePerGas: 178_000_000_000n },
    });
    jest.advanceTimersByTime(25);

    await expect(promise).rejects.toThrow('submitUserOperation timed out');
    expect(sendUserOperation).toHaveBeenCalledTimes(1);
  });

  it('persists a late provider hash once, without turning a timeout into a retry', async () => {
    const configService = { getOrThrow: jest.fn(() => 'secret'), get: jest.fn(() => 25) };
    const service = new OpenfortService(configService as any) as any;
    let resolveSubmission!: (hash: string) => void;
    const sendUserOperation = jest.fn().mockReturnValue(
      new Promise<string>((resolve) => { resolveSubmission = resolve; }),
    );
    jest.spyOn(service, 'createBundlerClient').mockReturnValue({ sendUserOperation });
    const onHash = jest.fn().mockResolvedValue(undefined);
    const promise = service.sendUserOperationWithSponsorship({
      account: {}, chain: {}, client: {}, transport: {},
      interactions: [{ to: '0x1111111111111111111111111111111111111111', data: '0x', value: '0' }],
      sponsorshipMode: 'required', chainId: 137,
      gasPrice: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, onUserOperationHash: onHash,
    });

    jest.advanceTimersByTime(25);
    await expect(promise).rejects.toThrow('submitUserOperation timed out');
    resolveSubmission(`0x${'a'.repeat(64)}`);
    await Promise.resolve();
    await Promise.resolve();
    expect(onHash).toHaveBeenCalledWith(`0x${'a'.repeat(64)}`);
    expect(sendUserOperation).toHaveBeenCalledTimes(1);
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

  it('uses Openfort fee endpoint for UserOperation fees', async () => {
    const configService = {
      getOrThrow: jest.fn(() => 'secret'),
      get: jest.fn(() => 25),
    };
    const service = new OpenfortService(configService as any) as any;

    const gasPrice = await service.estimateUserOperationFees({
      url: 'https://api.openfort.io/rpc/137',
      authorizationHeader: 'Bearer pk_test',
      gasPriceMethod: 'openfort_getUserOperationGasPrice',
      providerName: 'Openfort',
    });

    expect(gasPrice.maxFeePerGas.toString()).toBe('250000000000');
    expect(gasPrice.maxPriorityFeePerGas.toString()).toBe('178000000000');
    expect(mockFetch).toHaveBeenCalledWith('https://api.openfort.io/rpc/137', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer pk_test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'openfort_getUserOperationGasPrice',
        params: [],
      }),
    });
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

  describe('getTransactionReceipt', () => {
    const TX_HASH = '0x1111111111111111111111111111111111111111111111111111111111111111';
    const receipt = {
      status: 'success',
      transactionHash: TX_HASH,
      from: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      blockNumber: 12345n,
      blockHash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      gasUsed: 21000n,
      effectiveGasPrice: 1000000000n,
      logs: [
        {
          address: '0xdddddddddddddddddddddddddddddddddddddddd',
          topics: ['0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'],
          data: '0x0000000000000000000000000000000000000000000000000000000000000001',
          logIndex: 0,
          removed: false,
        },
      ],
    };

    const configService = {
      getOrThrow: jest.fn(() => 'secret'),
      get: jest.fn(() => 25),
    };

    it('returns a sanitized success receipt with block timestamp and logs', async () => {
      mockGetTransactionReceipt.mockResolvedValue(receipt);
      mockGetBlock.mockResolvedValue({ timestamp: 1_700_000_000n });

      const service = new OpenfortService(configService as any);
      const result = await service.getTransactionReceipt(84532, TX_HASH);

      expect(result.status).toBe('success');
      if (result.status !== 'success') return;
      expect(result.receipt.transactionHash).toBe(TX_HASH);
      expect(result.receipt.blockTimestamp).toBe(1_700_000_000n);
      expect(result.receipt.blockNumber).toBe(12345n);
      expect(result.receipt.logs).toHaveLength(1);
      expect(result.receipt.logs[0]).toEqual({
        address: '0xdddddddddddddddddddddddddddddddddddddddd',
        topics: ['0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'],
        data: '0x0000000000000000000000000000000000000000000000000000000000000001',
        logIndex: 0,
        removed: false,
      });
      // never leaks calldata or raw provider objects
      expect(result.receipt).not.toHaveProperty('input');
      expect(result.receipt).not.toHaveProperty('client');
      expect(result.receipt).not.toHaveProperty('transport');
    });

    it('returns reverted for a reverted receipt', async () => {
      mockGetTransactionReceipt.mockResolvedValue({ ...receipt, status: 'reverted' });
      mockGetBlock.mockResolvedValue({ timestamp: 1_700_000_000n });

      const service = new OpenfortService(configService as any);
      const result = await service.getTransactionReceipt(84532, TX_HASH);

      expect(result.status).toBe('reverted');
    });

    it('returns a retryable error when the provider returns null logs', async () => {
      mockGetTransactionReceipt.mockResolvedValue({ ...receipt, logs: null });

      const service = new OpenfortService(configService as any);
      const result = await service.getTransactionReceipt(84532, TX_HASH);

      expect(result).toEqual({
        status: 'error',
        message: 'receipt logs missing or malformed',
      });
      expect(mockGetBlock).not.toHaveBeenCalled();
    });

    it('returns a retryable error when the provider returns undefined logs', async () => {
      mockGetTransactionReceipt.mockResolvedValue({ ...receipt, logs: undefined });

      const service = new OpenfortService(configService as any);
      const result = await service.getTransactionReceipt(84532, TX_HASH);

      expect(result).toEqual({
        status: 'error',
        message: 'receipt logs missing or malformed',
      });
      expect(mockGetBlock).not.toHaveBeenCalled();
    });

    it('returns a retryable error when the provider returns non-array logs', async () => {
      mockGetTransactionReceipt.mockResolvedValue({ ...receipt, logs: '0xdeadbeef' });

      const service = new OpenfortService(configService as any);
      const result = await service.getTransactionReceipt(84532, TX_HASH);

      expect(result).toEqual({
        status: 'error',
        message: 'receipt logs missing or malformed',
      });
      expect(mockGetBlock).not.toHaveBeenCalled();
    });

    it('treats a legal empty logs array as a valid receipt', async () => {
      mockGetTransactionReceipt.mockResolvedValue({ ...receipt, logs: [] });
      mockGetBlock.mockResolvedValue({ timestamp: 1_700_000_000n });

      const service = new OpenfortService(configService as any);
      const result = await service.getTransactionReceipt(84532, TX_HASH);

      expect(result.status).toBe('success');
      if (result.status !== 'success') return;
      expect(result.receipt.logs).toEqual([]);
      expect(result.receipt.transactionHash).toBe(TX_HASH);
      expect(result.receipt.blockTimestamp).toBe(1_700_000_000n);
    });

    it('returns not_found when the receipt is not mined yet', async () => {
      mockGetTransactionReceipt.mockRejectedValue(new Error('Transaction receipt not found'));

      const service = new OpenfortService(configService as any);
      const result = await service.getTransactionReceipt(84532, TX_HASH);

      expect(result).toEqual({ status: 'not_found' });
    });

    it('returns a retryable error when the block lookup fails', async () => {
      const loggerErrorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      mockGetTransactionReceipt.mockResolvedValue(receipt);
      mockGetBlock.mockRejectedValue(new Error('RPC connection failed'));

      const service = new OpenfortService(configService as any);
      const result = await service.getTransactionReceipt(84532, TX_HASH);

      expect(result.status).toBe('error');
      loggerErrorSpy.mockRestore();
    });

    it('returns a retryable error on transient RPC failures', async () => {
      const loggerErrorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      mockGetTransactionReceipt.mockRejectedValue(new Error('RPC connection failed'));

      const service = new OpenfortService(configService as any);
      const result = await service.getTransactionReceipt(84532, TX_HASH);

      expect(result.status).toBe('error');
      loggerErrorSpy.mockRestore();
    });
  });

  it('maps UserOperation gas price failures to a specific API error', () => {
    const configService = {
      getOrThrow: jest.fn(() => 'secret'),
      get: jest.fn(() => 25),
    };
    const service = new OpenfortService(configService as any) as any;

    const exception = service.createOpenfortApiException(
      'sendUserOperation',
      new Error('Unable to estimate UserOperation fee parameters from Openfort RPC'),
    );

    expect(exception.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    expect(exception.getResponse()).toEqual({
      code: 'USER_OPERATION_GAS_PRICE_UNAVAILABLE',
      message: 'Unable to estimate UserOperation fee parameters from Openfort RPC.',
    });
  });

  it('prefers the new Calibur deployment and falls back to the legacy deployment', async () => {
    const configService = {
      getOrThrow: jest.fn(() => 'secret'),
      get: jest.fn(() => 25),
    };
    const service = new OpenfortService(configService as any) as any;

    mockGetCode.mockResolvedValueOnce('0x6000');
    await expect(service.assertCaliburContractAvailable({}, 84532)).resolves.toBeUndefined();
    expect(mockGetCode).toHaveBeenCalledTimes(1);
    expect(mockGetCode.mock.calls[0][1]).toEqual({
      address: '0x000000005c84F8Fd50b21CAC312528A64437030e',
    });

    mockGetCode.mockClear();
    mockGetCode.mockResolvedValueOnce('0x').mockResolvedValueOnce('0x6000');
    await expect(service.assertCaliburContractAvailable({}, 84532)).resolves.toBeUndefined();
    expect(mockGetCode.mock.calls.map((call) => call[1].address)).toEqual([
      '0x000000005c84F8Fd50b21CAC312528A64437030e',
      '0x000000009b1d0af20d8c6d0a44e162d11f9b8f00',
    ]);
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
