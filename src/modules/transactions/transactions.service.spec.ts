import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

jest.mock('../../core/openfort/openfort.service', () => ({
  OpenfortService: class OpenfortService {},
}));

import { SessionKeyPolicyService } from '../session-key/session-key-policy.service';
import { TransactionsService } from './transactions.service';
import { TransactionPolicyService } from './transaction-policy.service';

describe('TransactionsService', () => {
  const apiKeyPrefix = 'sk_1234567890abcdef12345678';
  const wallet = {
    id: 'wallet-1',
    openfortAccountId: 'acc-1',
    walletAddress: '0xABCDEF1234567890ABCDEf1234567890abcdef12',
    agentOpenfortAccountId: 'agent-acc-1',
    agentWalletAddress: '0x2222222222222222222222222222222222222222',
    agentKeyHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
    chainId: BigInt(84532),
    status: 'active',
    chainAuthorizations: [
      {
        chainId: BigInt(84532),
        status: 'registered',
        expiresAt: new Date('2027-05-06T00:00:00.000Z'),
        registrationTxHash: null,
        updatedAt: new Date('2026-05-06T00:00:00.000Z'),
      },
    ],
  };

  const dto = {
    chainId: 8453,
    interactions: [{ to: '0x1111111111111111111111111111111111111111', data: '0x', value: '0' }],
    idempotencyKey: 'idem-1',
  };

  const apiKeyContext = {
    id: 'api-key-1',
    keyPrefix: apiKeyPrefix,
    name: 'Production key',
    allowedIps: ['203.0.113.10'],
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    canSendTransaction: true,
    canReadTransactionStatus: true,
    canUseEoaExecution: false,
    allowedContracts: undefined,
    allowedFunctionSelectors: undefined,
    dailySpendLimit: undefined,
    monthlySpendLimit: undefined,
  };

  const prisma = {
    userWallet: { findUnique: jest.fn() },
    transaction: {
      create: jest.fn(),
      update: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
  } as any;

  const openfort = {
    verifyAgentKeyRegistration: jest.fn(),
    sendUserOperation: jest.fn(),
    sendBackendTransaction: jest.fn(),
  } as any;

  const eoaExecutionPolicy = { assertAllowed: jest.fn() } as any;
  const transactionSimulation = { assertSimulatable: jest.fn() } as any;
  const transactionPolicy = new TransactionPolicyService();
  const mockAssertSessionKeyAllowed = jest.fn();

  let service: TransactionsService;
  let loggerWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    loggerWarnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    prisma.userWallet.findUnique.mockResolvedValue(wallet);
    prisma.transaction.findFirst.mockResolvedValue(null);
    prisma.transaction.create.mockResolvedValue({
      id: 'tx-1',
      status: 'submitting',
      txHash: null,
    });
    prisma.transaction.update.mockResolvedValue({
      id: 'tx-1',
      status: 'confirmed',
      txHash: '0xhash',
    });
    openfort.sendUserOperation.mockResolvedValue({
      userOpHash: '0xuserop',
      transactionHash: '0xhash',
    });
    openfort.sendBackendTransaction.mockResolvedValue({ transactionHash: '0xhash' });
    openfort.verifyAgentKeyRegistration.mockResolvedValue({ registered: true });
    mockAssertSessionKeyAllowed.mockResolvedValue(undefined);
    eoaExecutionPolicy.assertAllowed.mockResolvedValue(undefined);
    transactionSimulation.assertSimulatable.mockResolvedValue(undefined);
    service = new TransactionsService(
      prisma,
      openfort,
      transactionPolicy,
      eoaExecutionPolicy,
      transactionSimulation,
      undefined, // riskEvaluation
      { assertSessionKeyAllowed: mockAssertSessionKeyAllowed } as any, // sessionKeyPolicy
    );
  });

  afterEach(() => {
    loggerWarnSpy.mockRestore();
  });

  it('uses requested chainId and creates idempotency record before sending', async () => {
    await service.send('user-1', dto as any, apiKeyContext);

    expect(mockAssertSessionKeyAllowed).toHaveBeenCalledWith({
      userId: 'user-1',
      walletId: wallet.id,
      apiKeyId: 'api-key-1',
      apiKeyPrefix,
      chainId: 8453,
      accountAddress: wallet.walletAddress,
      keyHash: wallet.agentKeyHash,
      operation: 'send_transaction',
      allowedContracts: apiKeyContext.allowedContracts,
      allowedFunctionSelectors: apiKeyContext.allowedFunctionSelectors,
      dailySpendLimit: apiKeyContext.dailySpendLimit,
      monthlySpendLimit: apiKeyContext.monthlySpendLimit,
      apiKeyExpiresAt: apiKeyContext.expiresAt,
    });

    expect(transactionSimulation.assertSimulatable).toHaveBeenCalledWith(dto, {
      userId: 'user-1',
      apiKeyId: 'api-key-1',
      apiKeyPrefix,
      chainId: 8453,
      executionMode: 'session_key',
      from: wallet.walletAddress,
    });

    expect(prisma.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        apiKeyId: 'api-key-1',
        authMethod: 'api_key',
        apiKeyPrefix,
        apiKeyName: 'Production key',
        status: 'submitting',
        chainId: BigInt(8453),
        operationType: 'send',
        idempotencyKey: 'idem-1',
        requestHash: expect.any(String),
        details: expect.objectContaining({
          type: 'send',
          interactionCount: 1,
          requestHash: expect.any(String),
        }),
      }),
    });
    expect(prisma.transaction.create.mock.calls[0][0].data.details).not.toHaveProperty(
      'interactions',
    );
    expect(openfort.sendUserOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: 8453,
        accountAddress: wallet.walletAddress,
        agentAccountId: wallet.agentOpenfortAccountId,
        keyHash: wallet.agentKeyHash,
        sponsorship: 'none',
      }),
    );
  });

  it('does not use paymaster sponsorship by default for session_key UserOps', async () => {
    await service.send('user-1', dto as any, apiKeyContext);

    expect(openfort.sendUserOperation).toHaveBeenCalledWith(
      expect.objectContaining({ sponsorship: 'none' }),
    );
    expect(prisma.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        details: expect.objectContaining({ sponsorship: 'none' }),
      }),
    });
  });

  it('passes explicit required sponsorship to session_key UserOps', async () => {
    await service.send('user-1', { ...dto, sponsorship: 'required' } as any, apiKeyContext);

    expect(openfort.sendUserOperation).toHaveBeenCalledWith(
      expect.objectContaining({ sponsorship: 'required' }),
    );
  });

  it('uses the backend wallet for eoa transaction sending and skips agent verification', async () => {
    await service.send('user-1', { ...dto, executionMode: 'eoa' } as any, {
      ...apiKeyContext,
      canUseEoaExecution: true,
    });

    expect(mockAssertSessionKeyAllowed).not.toHaveBeenCalled();
    expect(eoaExecutionPolicy.assertAllowed).toHaveBeenCalledWith({
      operation: 'send_transaction',
      userId: 'user-1',
      apiKeyId: 'api-key-1',
      apiKeyPrefix,
      allowedIps: ['203.0.113.10'],
      expiresAt: expect.any(Date),
      chainId: 8453,
      metadata: { interactionCount: 1 },
    });
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
    expect(transactionSimulation.assertSimulatable).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ executionMode: 'eoa', from: wallet.agentWalletAddress }),
    );
    expect(openfort.sendBackendTransaction).toHaveBeenCalledWith({
      accountId: wallet.agentOpenfortAccountId,
      chainId: 8453,
      interactions: dto.interactions,
    });
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'security',
        message: 'Privileged EOA transaction requested',
        userId: 'user-1',
        chainId: 8453,
        executionMode: 'eoa',
        interactionCount: 1,
        apiKeyPrefix,
      }),
    );
    expect(prisma.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        walletAddress: wallet.agentWalletAddress,
        details: expect.objectContaining({ executionMode: 'eoa', execution: 'backend_eoa' }),
      }),
    });
  });

  it('rejects transaction sending when the API key lacks send permission', async () => {
    await expect(
      service.send('user-1', dto as any, { ...apiKeyContext, canSendTransaction: false }),
    ).rejects.toThrow(ForbiddenException);

    expect(prisma.userWallet.findUnique).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('rejects eoa execution when the API key lacks eoa permission', async () => {
    await expect(service.send('user-1', { ...dto, executionMode: 'eoa' } as any, apiKeyContext)).rejects.toThrow(
      ForbiddenException,
    );

    expect(prisma.userWallet.findUnique).not.toHaveBeenCalled();
    expect(eoaExecutionPolicy.assertAllowed).not.toHaveBeenCalled();
    expect(openfort.sendBackendTransaction).not.toHaveBeenCalled();
  });

  it('rejects eoa execution when the EOA isolation policy denies the request', async () => {
    eoaExecutionPolicy.assertAllowed.mockRejectedValueOnce(
      new ForbiddenException('EOA execution rate limit exceeded'),
    );

    await expect(
      service.send('user-1', { ...dto, executionMode: 'eoa' } as any, {
        ...apiKeyContext,
        canUseEoaExecution: true,
      }),
    ).rejects.toThrow('EOA execution rate limit exceeded');

    expect(prisma.userWallet.findUnique).not.toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendBackendTransaction).not.toHaveBeenCalled();
  });

  it('rejects transactions with native value before loading the wallet', async () => {
    await expect(
      service.send(
        'user-1',
        {
          ...dto,
          interactions: [{ ...dto.interactions[0], value: '1' }],
        } as any,
        apiKeyContext,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.userWallet.findUnique).not.toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('rejects transactions with too many interactions before loading the wallet', async () => {
    await expect(
      service.send(
        'user-1',
        {
          ...dto,
          interactions: Array.from({ length: 11 }, (_, index) => ({
            ...dto.interactions[0],
            to: `0x${String(index + 1).padStart(40, '0')}`,
          })),
        } as any,
        apiKeyContext,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.userWallet.findUnique).not.toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('rejects infinite token approvals before loading the wallet', async () => {
    const infiniteApprovalCalldata =
      '0x095ea7b3' +
      '000000000000000000000000e111180000d2663c0091e4f400237545b87b996b' +
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

    await expect(
      service.send(
        'user-1',
        {
          ...dto,
          interactions: [
            {
              ...dto.interactions[0],
              data: infiniteApprovalCalldata,
            },
          ],
        } as any,
        apiKeyContext,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.userWallet.findUnique).not.toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'security',
        message: 'Transaction policy rejected request',
        reason: 'Infinite token approvals are not allowed',
        userId: 'user-1',
        chainId: dto.chainId,
        executionMode: 'session_key',
        apiKeyPrefix,
        interactionIndex: 0,
        selector: '0x095ea7b3',
      }),
    );
    expect(JSON.stringify(loggerWarnSpy.mock.calls)).not.toContain(infiniteApprovalCalldata);
  });

  it('rejects Permit/Permit2 calldata before loading the wallet', async () => {
    await expect(
      service.send(
        'user-1',
        {
          ...dto,
          interactions: [{ ...dto.interactions[0], data: '0xd505accf' }],
        } as any,
        apiKeyContext,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.userWallet.findUnique).not.toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('rejects oversized aggregate calldata before loading the wallet', async () => {
    const largeCalldata = `0x${'11'.repeat(33 * 1024)}`;

    await expect(
      service.send(
        'user-1',
        {
          ...dto,
          interactions: [
            { ...dto.interactions[0], data: largeCalldata },
            { ...dto.interactions[0], data: largeCalldata },
          ],
        } as any,
        apiKeyContext,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.userWallet.findUnique).not.toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'security',
        message: 'Transaction policy rejected request',
        reason: 'Transaction calldata exceeds maximum total size of 64 KB',
        totalCalldataBytes: 67584,
      }),
    );
  });

  it.each([
    ['0xd505accf', 'ERC-2612 permit(address,address,uint256,uint256,uint8,bytes32,bytes32)'],
    ['0x8fcbaf0c', 'DAI-style permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)'],
    ['0x2b67b570', 'Permit2 permit(address,PermitSingle,bytes)'],
    ['0xb7f13ed4', 'Permit2 compact/single permit variant'],
    ['0x002a3e3a', 'Permit2 permitBatch(address,PermitBatch,bytes)'],
  ])('rejects blocked permit selector %s before loading the wallet', async (selector) => {
    await expect(
      service.send(
        'user-1',
        {
          ...dto,
          interactions: [{ ...dto.interactions[0], data: selector }],
        } as any,
        apiKeyContext,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.userWallet.findUnique).not.toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('rejects max-uint ERC20 approvals before loading the wallet', async () => {
    const maxUintApprovalCalldata =
      '0x095ea7b3' +
      '000000000000000000000000e111180000d2663c0091e4f400237545b87b996b' +
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

    await expect(
      service.send(
        'user-1',
        {
          ...dto,
          interactions: [{ ...dto.interactions[0], data: maxUintApprovalCalldata }],
        } as any,
        apiKeyContext,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.userWallet.findUnique).not.toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'security',
        message: 'Transaction policy rejected request',
        reason: 'Infinite token approvals are not allowed',
        userId: 'user-1',
        chainId: dto.chainId,
        executionMode: 'session_key',
        apiKeyPrefix,
        interactionIndex: 0,
        selector: '0x095ea7b3',
      }),
    );
  });

  it('rejects NFT operator approvals before loading the wallet', async () => {
    const nftOperatorApprovalCalldata =
      '0xa22cb465' +
      '000000000000000000000000e111180000d2663c0091e4f400237545b87b996b' +
      '0000000000000000000000000000000000000000000000000000000000000001';

    await expect(
      service.send(
        'user-1',
        {
          ...dto,
          interactions: [{ ...dto.interactions[0], data: nftOperatorApprovalCalldata }],
        } as any,
        apiKeyContext,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.userWallet.findUnique).not.toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'security',
        message: 'Transaction policy rejected request',
        reason: 'NFT operator approvals are not allowed',
        userId: 'user-1',
        chainId: dto.chainId,
        executionMode: 'session_key',
        apiKeyPrefix,
        interactionIndex: 0,
        selector: '0xa22cb465',
      }),
    );
  });

  it('propagates clear paymaster policy failures when sponsorship is required', async () => {
    openfort.sendUserOperation.mockRejectedValue(
      new HttpException(
        {
          code: 'PAYMASTER_POLICY_NOT_CONFIGURED',
          message: 'No gas sponsorship policy is configured for chainId 8453.',
        },
        HttpStatus.FAILED_DEPENDENCY,
      ),
    );

    await expect(
      service.send('user-1', { ...dto, sponsorship: 'required' } as any, apiKeyContext),
    ).rejects.toMatchObject({ status: 424 });

    expect(prisma.transaction.update).toHaveBeenCalledWith({
      where: { id: 'tx-1' },
      data: expect.objectContaining({
        status: 'failed',
        failureReason: expect.stringContaining(
          'No gas sponsorship policy is configured for chainId 8453.',
        ),
      }),
    });
  });

  it('rejects bearer-token transaction submission before loading the wallet', async () => {
    await expect(service.send('user-1', dto as any)).rejects.toThrow(UnauthorizedException);

    expect(prisma.userWallet.findUnique).not.toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('rejects frozen wallets before creating or sending transactions', async () => {
    prisma.userWallet.findUnique.mockResolvedValue({
      ...wallet,
      frozenAt: new Date('2026-05-28T00:00:00.000Z'),
      frozenReason: 'wallet_compromise',
    });

    await expect(service.send('user-1', dto as any, apiKeyContext)).rejects.toThrow(
      ForbiddenException,
    );

    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(transactionSimulation.assertSimulatable).not.toHaveBeenCalled();
    expect(mockAssertSessionKeyAllowed).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('rejects failed transaction simulation before idempotency persistence or Openfort send', async () => {
    transactionSimulation.assertSimulatable.mockRejectedValueOnce(
      new BadRequestException('Transaction simulation failed. Check target contract calldata and permissions.'),
    );

    await expect(service.send('user-1', dto as any, apiKeyContext)).rejects.toThrow(
      'Transaction simulation failed',
    );

    expect(transactionSimulation.assertSimulatable).toHaveBeenCalledWith(
      dto,
      expect.objectContaining({ from: wallet.walletAddress, executionMode: 'session_key' }),
    );
    expect(prisma.transaction.findFirst).toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('rejects pending agent status before sending', async () => {
    prisma.userWallet.findUnique.mockResolvedValue({
      ...wallet,
      chainAuthorizations: [{ ...wallet.chainAuthorizations[0], status: 'pending_registration' }],
    });

    await expect(service.send('user-1', dto as any, apiKeyContext)).rejects.toThrow(
      BadRequestException,
    );

    expect(mockAssertSessionKeyAllowed).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('rejects expired agent registration before sending', async () => {
    prisma.userWallet.findUnique.mockResolvedValue({
      ...wallet,
      chainAuthorizations: [
        { ...wallet.chainAuthorizations[0], expiresAt: new Date('2026-05-04T00:00:00.000Z') },
      ],
    });

    await expect(service.send('user-1', dto as any, apiKeyContext)).rejects.toThrow(
      BadRequestException,
    );

    expect(mockAssertSessionKeyAllowed).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('returns existing transaction on idempotency collision without resending', async () => {
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-existing',
      status: 'pending',
      txHash: null,
    });

    const result = await service.send('user-1', dto as any, apiKeyContext);

    expect(result).toEqual({
      transactionId: 'tx-existing',
      transactionHash: null,
      status: 'pending',
    });
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('returns an in-progress transaction on idempotency collision without resending', async () => {
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-existing',
      status: 'submitting',
      txHash: null,
    });

    const result = await service.send('user-1', dto as any, apiKeyContext);

    expect(result).toEqual({
      transactionId: 'tx-existing',
      transactionHash: null,
      status: 'submitting',
    });
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('returns an existing transaction before Openfort send', async () => {
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-existing',
      status: 'pending',
      txHash: null,
    });

    const result = await service.send('user-1', dto as any, apiKeyContext);

    expect(result).toEqual({
      transactionId: 'tx-existing',
      transactionHash: null,
      status: 'pending',
    });
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('returns the existing transaction after a concurrent idempotency insert race', async () => {
    prisma.transaction.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'tx-existing',
      status: 'submitting',
      txHash: null,
    });
    prisma.transaction.create.mockRejectedValue({ code: 'P2002' });

    const result = await service.send('user-1', dto as any, apiKeyContext);

    expect(result).toEqual({
      transactionId: 'tx-existing',
      transactionHash: null,
      status: 'submitting',
    });
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it.each([
    {
      status: 'confirmed',
      txHash: '0xconfirmed',
      expectedHash: '0xconfirmed',
    },
    { status: 'failed', txHash: null, expectedHash: null },
  ])(
    'returns existing $status transaction on idempotency collision without resending',
    async ({ status, txHash, expectedHash }) => {
      prisma.transaction.findFirst.mockResolvedValue({
        id: 'tx-existing',
        status,
        txHash,
      });

      const result = await service.send('user-1', dto as any, apiKeyContext);

      expect(result).toEqual({
        transactionId: 'tx-existing',
        transactionHash: expectedHash,
        status,
      });
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(openfort.sendUserOperation).not.toHaveBeenCalled();
    },
  );

  it('rejects idempotency key reuse with a different request on the same chain', async () => {
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-existing',
      status: 'pending',
      txHash: null,
      requestHash: 'different-request',
    });

    await expect(service.send('user-1', dto as any, apiKeyContext)).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('marks transaction failed and stores summarized failure reason when Openfort submission fails', async () => {
    openfort.sendUserOperation.mockRejectedValue(new Error('Openfort rejected transaction'));

    await expect(service.send('user-1', dto as any, apiKeyContext)).rejects.toThrow(
      'Openfort rejected transaction',
    );

    expect(prisma.transaction.update).toHaveBeenCalledWith({
      where: { id: 'tx-1' },
      data: expect.objectContaining({
        status: 'failed',
        failureReason: 'Openfort rejected transaction',
        completedAt: expect.any(Date),
      }),
    });
  });

  it('stores pending status when transaction hash is not available yet', async () => {
    openfort.sendUserOperation.mockResolvedValue({ userOpHash: '0xuserop', transactionHash: null });
    prisma.transaction.update.mockResolvedValue({
      id: 'tx-1',
      status: 'pending',
      txHash: null,
    });

    await expect(service.send('user-1', dto as any, apiKeyContext)).resolves.toEqual({
      transactionId: 'tx-1',
      transactionHash: null,
      status: 'pending',
    });
    expect(prisma.transaction.update).toHaveBeenCalledWith({
      where: { id: 'tx-1' },
      data: expect.objectContaining({
        txHash: null,
        status: 'pending',
      }),
    });
  });

  it('returns a safe status response for an owned transaction', async () => {
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-1',
      userId: 'user-1',
      status: 'confirmed',
      txHash: '0xhash',
      chainId: BigInt(8453),
      walletAddress: wallet.walletAddress,
      operationType: 'send',
      authMethod: 'api_key',
      failureReason: null,
      createdAt: new Date('2026-04-28T00:00:00.000Z'),
      completedAt: new Date('2026-04-28T00:01:00.000Z'),
    });

    await expect(service.getStatus('user-1', 'tx-1', apiKeyContext)).resolves.toEqual({
      transactionId: 'tx-1',
      transactionHash: '0xhash',
      status: 'confirmed',
      chainId: 8453,
      walletAddress: wallet.walletAddress,
      failureReason: null,
      createdAt: new Date('2026-04-28T00:00:00.000Z'),
      completedAt: new Date('2026-04-28T00:01:00.000Z'),
    });
  });

  it('rejects status lookups when the API key lacks read permission', async () => {
    await expect(
      service.getStatus('user-1', 'tx-1', { ...apiKeyContext, canReadTransactionStatus: false }),
    ).rejects.toThrow(ForbiddenException);

    expect(prisma.transaction.findFirst).not.toHaveBeenCalled();
  });

  it('returns stored pending status without Openfort status refresh', async () => {
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-1',
      status: 'pending',
      txHash: null,
      chainId: BigInt(8453),
      walletAddress: wallet.walletAddress,
      operationType: 'send',
      authMethod: 'api_key',
      failureReason: null,
      createdAt: new Date('2026-04-28T00:00:00.000Z'),
      completedAt: null,
    });

    await expect(service.getStatus('user-1', 'tx-1', apiKeyContext)).resolves.toEqual(
      expect.objectContaining({ status: 'pending', transactionHash: null }),
    );
  });

  it('rejects status lookups for non-send operations', async () => {
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-1',
      userId: 'user-1',
      status: 'confirmed',
      txHash: '0xhash',
      chainId: BigInt(8453),
      walletAddress: wallet.walletAddress,
      operationType: 'withdraw',
      authMethod: 'api_key',
    });

    await expect(service.getStatus('user-1', 'tx-1', apiKeyContext)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('rejects status lookups for non-api-key auth methods', async () => {
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-1',
      userId: 'user-1',
      status: 'confirmed',
      txHash: '0xhash',
      chainId: BigInt(8453),
      walletAddress: wallet.walletAddress,
      operationType: 'send',
      authMethod: 'iam',
    });

    await expect(service.getStatus('user-1', 'tx-1', apiKeyContext)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('does not expose transactions owned by another user', async () => {
    prisma.transaction.findFirst.mockResolvedValue(null);

    await expect(service.getStatus('user-1', 'tx-other', apiKeyContext)).rejects.toThrow(
      NotFoundException,
    );
  });
});
