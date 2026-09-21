import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { encodeFunctionData, getAddress, type Hex } from 'viem';

jest.mock('../../core/openfort/openfort.service', () => ({
  OpenfortService: class OpenfortService {},
}));

const mockVerifyTransactionAssetFlow = jest.fn();

jest.mock('./transaction-asset-flow.verifier', () => {
  const actual = jest.requireActual<typeof import('./transaction-asset-flow.verifier')>(
    './transaction-asset-flow.verifier',
  );
  return {
    ...actual,
    verifyTransactionAssetFlow: (...args: unknown[]) => mockVerifyTransactionAssetFlow(...args),
  };
});

import { TransactionsService } from './transactions.service';
import { TransactionPolicyService } from './transaction-policy.service';
import { API_ERROR_CODES } from '../../common/errors/api-error-codes';
import {
  computeAssetFlowPlanDigest,
  verifyTransactionAssetFlow as realVerifyTransactionAssetFlow,
} from './transaction-asset-flow.verifier';
import { AssetFlowSimulationUnavailableError } from './transaction-simulation.service';

function erc20TransferData(to: string, amount: bigint = 1n): string {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'transfer',
        inputs: [
          { name: 'to', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
        outputs: [{ type: 'bool' }],
        stateMutability: 'nonpayable',
      },
    ],
    functionName: 'transfer',
    args: [to as Hex, amount],
  });
}

function erc20ApproveData(spender: string, amount: bigint = 1n): string {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'approve',
        inputs: [
          { name: 'spender', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
        outputs: [{ type: 'bool' }],
        stateMutability: 'nonpayable',
      },
    ],
    functionName: 'approve',
    args: [spender as Hex, amount],
  });
}

const TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const EXTERNAL = '0x1111111111111111111111111111111111111111';
/** Official Aave V3 Pool on Base (chainId 8453) — retained-protocol registry target. */
const AAVE_POOL_8453 = '0xa238dd80c259a72e81d7e4664a9801593f98d1c5';

function aaveSupplyData(onBehalfOf: string, amount: bigint = 1n): string {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'supply',
        inputs: [
          { name: 'asset', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'onBehalfOf', type: 'address' },
          { name: 'referralCode', type: 'uint16' },
        ],
        outputs: [],
        stateMutability: 'nonpayable',
      },
    ],
    functionName: 'supply',
    args: [TOKEN as Hex, amount, onBehalfOf as Hex, 0],
  });
}

describe('TransactionsService', () => {
  const apiKeyPrefix = 'sk_1234567890abcdef12345678';
  // Checksum-valid addresses so asset-flow classification can normalize owner.
  const wallet = {
    id: 'wallet-1',
    openfortAccountId: 'acc-1',
    walletAddress: '0xabCDEF1234567890ABcDEF1234567890aBCDeF12',
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
    // BILL-016: unit fixtures assume destination-policy reauth already completed.
    directEgressPolicyAcceptedAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  const destinationPolicy = {
    acquireUserDestinationLock: jest.fn().mockResolvedValue(undefined),
    assertDestinationsAllowed: jest.fn().mockResolvedValue(undefined),
    recordDeferredDenial: jest.fn().mockResolvedValue(undefined),
  };

  /** Interactive-tx findFirst — distinct from root so P2002 recovery can be asserted. */
  const txFindFirst = jest.fn();

  /** FOR UPDATE key-row result used inside create TX (BILL-016). */
  const txApiKeyLockRows = jest.fn();

  const prisma = {
    userWallet: { findUnique: jest.fn() },
    apiKey: { findUnique: jest.fn() },
    transaction: {
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockImplementation(async ({ data }: any) => {
        prisma.transaction.update({ where: { id: 'tx-1' }, data });
        return { count: 1 };
      }),
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    $transaction: jest.fn(),
  } as any;

  const openfort = {
    verifyAgentKeyRegistration: jest.fn(),
    submitUserOperation: jest.fn(),
    waitForUserOperationReceipt: jest.fn(),
    sendBackendTransaction: jest.fn(),
    getTransactionReceipt: jest.fn(),
  } as any;
  // Keep legacy assertions pointed at the split submission seam.
  openfort.sendUserOperation = openfort.submitUserOperation;

  const eoaExecutionPolicy = { assertAllowed: jest.fn() } as any;
  const transactionSimulation = {
    assertSimulatable: jest.fn(),
    simulateAssetFlowEvidence: jest.fn(),
  } as any;
  const transactionPolicy = new TransactionPolicyService(prisma, undefined as any);
  const mockAssertSessionKeyAllowed = jest.fn();
  const billingDebt = { getDebt: jest.fn() } as any;
  const SIM_RPC = 'https://rpc.example.test/base';
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'simulation.rpcUrls.8453') return SIM_RPC;
      return undefined;
    }),
  } as any;

  let service: TransactionsService;
  let loggerWarnSpy: jest.SpyInstance;

  function buildPlanDigest(
    interactions: ReadonlyArray<{ to: string; data: string; value?: string }>,
    ownerAddress: string,
    executionMode: 'session_key' | 'eoa' = 'session_key',
    chainId = 8453,
  ) {
    return computeAssetFlowPlanDigest({
      ownerAddress,
      chainId,
      executionMode,
      interactions,
    })!;
  }

  function mockProductionEvidence(plan: {
    interactions: ReadonlyArray<{ to: string; data: string; value?: string }>;
    ownerAddress: string;
    executionMode?: 'session_key' | 'eoa';
    chainId?: number;
  }) {
    const executionMode = plan.executionMode ?? 'session_key';
    const chainId = plan.chainId ?? 8453;
    const planDigest = buildPlanDigest(
      plan.interactions,
      plan.ownerAddress,
      executionMode,
      chainId,
    );
    return {
      simulationMode: 'eth_simulateV1_non_atomic' as const,
      binding: {
        ownerAddress: getAddress(plan.ownerAddress),
        chainId,
        executionMode,
        planDigest,
        schemaVersion: 'asset-flow-evidence.v1',
        ruleVersion: 'asset-flow-rules.v1',
        baseBlock: { number: null, hash: null },
        simulatedBlock: { number: 1n, hash: `0x${'ab'.repeat(32)}` },
      },
      coverage: {
        assetObservation: { completeness: 'incomplete' as const },
        internalCalls: { completeness: 'unknown' as const, observed: false },
        permissions: { completeness: 'unknown' as const },
      },
      results: plan.interactions.map(() => ({ status: 'success' as const })),
      assetChanges: [],
      relations: [],
      logs: { completeness: 'unknown' as const },
    };
  }

  function mockVerifiedVerdict(_plan: {
    interactions: ReadonlyArray<{ to: string; data: string; value?: string }>;
    ownerAddress: string;
    executionMode?: 'session_key' | 'eoa';
    chainId?: number;
  }) {
    void _plan;
    return {
      status: 'verified' as const,
      rule: 'test_verified',
      reason: 'synthetic verified for unit test',
      simulationMode: 'calibur_atomic' as const,
      block: { number: 1n, hash: `0x${'ab'.repeat(32)}` },
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    loggerWarnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    prisma.userWallet.findUnique.mockResolvedValue(wallet);
    prisma.transaction.findFirst.mockResolvedValue(null);
    txFindFirst.mockResolvedValue(null);
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
    // Re-bind after tests that override CAS behavior (e.g. late completion race).
    prisma.transaction.updateMany.mockImplementation(async ({ data }: any) => {
      prisma.transaction.update({ where: { id: 'tx-1' }, data });
      return { count: 1 };
    });
    txApiKeyLockRows.mockResolvedValue([
      {
        user_id: 'user-1',
        revoked: false,
        frozen_at: null,
        expires_at: null,
        can_send_transaction: true,
        direct_egress_policy_accepted_at: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback({
        $executeRaw: jest.fn().mockResolvedValue(undefined),
        $queryRaw: txApiKeyLockRows,
        apiKey: { findUnique: jest.fn() },
        transaction: {
          findFirst: txFindFirst,
          create: prisma.transaction.create,
          update: prisma.transaction.update,
          updateMany: prisma.transaction.updateMany,
        },
      }),
    );
    destinationPolicy.acquireUserDestinationLock.mockResolvedValue(undefined);
    destinationPolicy.assertDestinationsAllowed.mockResolvedValue(undefined);
    destinationPolicy.recordDeferredDenial.mockResolvedValue(undefined);
    openfort.submitUserOperation.mockResolvedValue({ userOpHash: '0xuserop' });
    openfort.waitForUserOperationReceipt.mockResolvedValue({
      success: true,
      transactionHash: '0xhash',
    });
    openfort.sendBackendTransaction.mockResolvedValue({ transactionHash: '0xhash' });
    openfort.getTransactionReceipt.mockResolvedValue({ status: 'success' });
    openfort.verifyAgentKeyRegistration.mockResolvedValue({ registered: true });
    mockAssertSessionKeyAllowed.mockResolvedValue(undefined);
    eoaExecutionPolicy.assertAllowed.mockResolvedValue(undefined);
    transactionSimulation.assertSimulatable.mockResolvedValue(undefined);
    transactionSimulation.simulateAssetFlowEvidence.mockResolvedValue(
      mockProductionEvidence({
        interactions: dto.interactions,
        ownerAddress: wallet.walletAddress,
      }),
    );
    // Default: real verifier (production evidence never verifies).
    mockVerifyTransactionAssetFlow.mockImplementation((input: any) =>
      realVerifyTransactionAssetFlow(input),
    );
    billingDebt.getDebt.mockResolvedValue({ hasDebt: false, invoiceIds: [] });
    config.get.mockImplementation((key: string) => {
      if (key === 'simulation.rpcUrls.8453') return SIM_RPC;
      return undefined;
    });
    service = new TransactionsService(
      prisma,
      openfort,
      transactionPolicy,
      billingDebt,
      config,
      destinationPolicy as any,
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

    expect(prisma.transaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userOpSuccess: true }),
      }),
    );

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
    await expect(
      service.send('user-1', { ...dto, executionMode: 'eoa' } as any, apiKeyContext),
    ).rejects.toThrow(ForbiddenException);

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
      new BadRequestException(
        'Transaction simulation failed. Check target contract calldata and permissions.',
      ),
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

  it('returns the existing transaction after a concurrent idempotency insert race via root prisma', async () => {
    // Outer root miss → inner tx miss → P2002 aborts interactive tx → root re-read hits existing.
    prisma.transaction.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'tx-existing',
      status: 'submitting',
      txHash: null,
    });
    txFindFirst.mockResolvedValue(null);
    prisma.transaction.create.mockRejectedValue({ code: 'P2002' });

    const result = await service.send('user-1', dto as any, apiKeyContext);

    expect(result).toEqual({
      transactionId: 'tx-existing',
      transactionHash: null,
      status: 'submitting',
    });
    expect(txFindFirst).toHaveBeenCalledTimes(1);
    // Recovery must use root prisma findFirst (outer + post-P2002), not the aborted txClient.
    expect(prisma.transaction.findFirst).toHaveBeenCalledTimes(2);
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('rejects P2002 recovery when the concurrent row has a different requestHash', async () => {
    prisma.transaction.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'tx-existing',
      status: 'submitting',
      txHash: null,
      requestHash: 'different-request',
    });
    txFindFirst.mockResolvedValue(null);
    prisma.transaction.create.mockRejectedValue({ code: 'P2002' });

    await expect(service.send('user-1', dto as any, apiKeyContext)).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.transaction.findFirst).toHaveBeenCalledTimes(2);
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('rethrows P2002 when no existing transaction is found after rollback', async () => {
    prisma.transaction.findFirst.mockResolvedValue(null);
    txFindFirst.mockResolvedValue(null);
    prisma.transaction.create.mockRejectedValue({ code: 'P2002' });

    await expect(service.send('user-1', dto as any, apiKeyContext)).rejects.toMatchObject({
      code: 'P2002',
    });
    expect(prisma.transaction.findFirst).toHaveBeenCalledTimes(2);
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
    openfort.submitUserOperation.mockResolvedValue({ userOpHash: '0xuserop' });
    openfort.waitForUserOperationReceipt.mockResolvedValue({
      success: null,
      transactionHash: null,
    });
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
    expect(prisma.transaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'pending' }),
      }),
    );
  });

  it('does not confirm a reverted UserOperation inside a successful bundle receipt', async () => {
    openfort.submitUserOperation.mockResolvedValue({ userOpHash: '0xuserop' });
    openfort.waitForUserOperationReceipt.mockResolvedValue({
      success: false,
      transactionHash: '0xbundle',
    });
    openfort.getTransactionReceipt.mockResolvedValue({ status: 'success' });
    prisma.transaction.update.mockResolvedValue({
      id: 'tx-1',
      status: 'unknown',
      txHash: '0xbundle',
    });

    await expect(service.send('user-1', dto as any, apiKeyContext)).resolves.toEqual({
      transactionId: 'tx-1',
      transactionHash: '0xbundle',
      status: 'unknown',
    });
    expect(prisma.transaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'unknown',
          txHash: '0xbundle',
          userOpSuccess: false,
          details: expect.objectContaining({ userOperationSuccess: false }),
        }),
      }),
    );
    const completionWrite = prisma.transaction.updateMany.mock.calls.find(
      (call: any[]) => call[0].data.userOpSuccess === false,
    );
    expect(completionWrite?.[0].where).toEqual(
      expect.objectContaining({ userOpSuccess: null, billingReconciledAt: null }),
    );
  });

  it('does not overwrite reconciler-written typed success during a late completion race', async () => {
    prisma.transaction.updateMany.mockImplementation(async ({ data }: any) => {
      if (data.userOpSuccess !== undefined) return { count: 0 };
      prisma.transaction.update({ where: { id: 'tx-1' }, data });
      return { count: 1 };
    });

    await expect(service.send('user-1', dto as any, apiKeyContext)).resolves.toEqual({
      transactionId: 'tx-1',
      transactionHash: null,
      status: 'submitting',
    });

    const completionWrite = prisma.transaction.updateMany.mock.calls.find(
      (call: any[]) => call[0].data.userOpSuccess !== undefined,
    );
    expect(completionWrite?.[0].where).toEqual(
      expect.objectContaining({
        userOpSuccess: null,
        billingReconciledAt: null,
      }),
    );
    expect(prisma.transaction.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userOpSuccess: true }) }),
    );
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

  // ── Billing debt + asset-flow gate (Phase 2 evidence) ──────────────────────

  it('requires direct-egress reauthorization before a new external transfer', async () => {
    const externalDto = {
      ...dto,
      interactions: [{ to: TOKEN, data: erc20TransferData(EXTERNAL), value: '0' }],
      idempotencyKey: 'reauth-external-1',
    };

    await expect(
      service.send('user-1', externalDto as any, {
        ...apiKeyContext,
        directEgressPolicyAcceptedAt: null,
      }),
    ).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.API_KEY_DIRECT_EGRESS_REAUTH_REQUIRED },
    });
    expect(destinationPolicy.assertDestinationsAllowed).not.toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('enforces destination allowlist on external transfer before create/Openfort', async () => {
    destinationPolicy.assertDestinationsAllowed.mockRejectedValue(
      new ForbiddenException({
        code: API_ERROR_CODES.WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED,
        message: 'Withdrawal address is not allowlisted',
      }),
    );
    const externalDto = {
      ...dto,
      interactions: [{ to: TOKEN, data: erc20TransferData(EXTERNAL), value: '0' }],
      idempotencyKey: 'dest-deny-1',
    };

    await expect(service.send('user-1', externalDto as any, apiKeyContext)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED },
    });
    expect(destinationPolicy.assertDestinationsAllowed).toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('outer preflight pass + inner deferred deny: records audit once after TX, stable 403, no create/provider', async () => {
    const { DeferredDestinationPolicyDenial } =
      await import('../withdrawal-destination/withdrawal-destination-policy.service');
    const httpEx = new ForbiddenException({
      code: API_ERROR_CODES.WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED,
      message: 'Withdrawal address is not allowlisted',
    });
    const deferred = new DeferredDestinationPolicyDenial(httpEx, {
      actorType: 'api_key',
      userId: 'user-1',
      apiKeyId: 'api-key-1',
      reason: 'Withdrawal address is not allowlisted',
      metadata: {
        code: API_ERROR_CODES.WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED,
        apiKeyPrefix,
      },
    });
    // Outer preflight succeeds; inner create TX defers deny (allowlist raced away).
    destinationPolicy.assertDestinationsAllowed
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(deferred);

    const externalDto = {
      ...dto,
      interactions: [{ to: TOKEN, data: erc20TransferData(EXTERNAL), value: '0' }],
      idempotencyKey: 'dest-deferred-inner-1',
    };

    await expect(service.send('user-1', externalDto as any, apiKeyContext)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED },
    });

    expect(destinationPolicy.assertDestinationsAllowed).toHaveBeenCalledTimes(2);
    expect(destinationPolicy.recordDeferredDenial).toHaveBeenCalledTimes(1);
    expect(destinationPolicy.recordDeferredDenial).toHaveBeenCalledWith(deferred);
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('re-reads API key reauth state inside create TX and blocks create when revoked', async () => {
    txApiKeyLockRows.mockResolvedValue([
      {
        user_id: 'user-1',
        revoked: true,
        frozen_at: null,
        expires_at: null,
        can_send_transaction: true,
        direct_egress_policy_accepted_at: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
    const externalDto = {
      ...dto,
      interactions: [{ to: TOKEN, data: erc20TransferData(EXTERNAL), value: '0' }],
      idempotencyKey: 'in-tx-reauth-revoked-1',
    };

    await expect(service.send('user-1', externalDto as any, apiKeyContext)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.API_KEY_DIRECT_EGRESS_REAUTH_REQUIRED },
    });
    expect(txApiKeyLockRows).toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('re-reads API key reauth state inside create TX and blocks when acceptance cleared', async () => {
    txApiKeyLockRows.mockResolvedValue([
      {
        user_id: 'user-1',
        revoked: false,
        frozen_at: null,
        expires_at: null,
        can_send_transaction: true,
        direct_egress_policy_accepted_at: null,
      },
    ]);
    const externalDto = {
      ...dto,
      interactions: [{ to: TOKEN, data: erc20TransferData(EXTERNAL), value: '0' }],
      idempotencyKey: 'in-tx-reauth-cleared-1',
    };

    await expect(service.send('user-1', externalDto as any, apiKeyContext)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.API_KEY_DIRECT_EGRESS_REAUTH_REQUIRED },
    });
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('blocks debt + external_transfer without evidence simulation/create/Openfort', async () => {
    billingDebt.getDebt.mockResolvedValue({ hasDebt: true, invoiceIds: ['inv-1'] });
    const externalDto = {
      ...dto,
      interactions: [{ to: TOKEN, data: erc20TransferData(EXTERNAL), value: '0' }],
      idempotencyKey: 'debt-external-1',
    };

    await expect(service.send('user-1', externalDto as any, apiKeyContext)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.BILLING_OUTBOUND_BLOCKED },
    });

    expect(billingDebt.getDebt).toHaveBeenCalled();
    expect(transactionSimulation.simulateAssetFlowEvidence).not.toHaveBeenCalled();
    expect(mockVerifyTransactionAssetFlow).not.toHaveBeenCalled();
    expect(transactionSimulation.assertSimulatable).not.toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('debt + unknown with missing simulation.rpcUrls fails closed as UNVERIFIABLE (no public http fallback)', async () => {
    billingDebt.getDebt.mockResolvedValue({ hasDebt: true, invoiceIds: ['inv-1'] });
    config.get.mockImplementation(() => undefined);
    const unknownDto = {
      ...dto,
      interactions: [{ to: TOKEN, data: erc20ApproveData(EXTERNAL, 100n), value: '0' }],
      idempotencyKey: 'debt-missing-rpc-1',
    };

    await expect(service.send('user-1', unknownDto as any, apiKeyContext)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE },
    });

    expect(transactionSimulation.simulateAssetFlowEvidence).not.toHaveBeenCalled();
    expect(mockVerifyTransactionAssetFlow).not.toHaveBeenCalled();
    expect(transactionSimulation.assertSimulatable).not.toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Transaction send blocked by billing debt asset-flow gate',
        reason: 'missing_simulation_rpc',
        chainId: 8453,
      }),
    );
  });

  it('debt path rejects non-https simulation.rpcUrls at resolve time', async () => {
    billingDebt.getDebt.mockResolvedValue({ hasDebt: true, invoiceIds: ['inv-1'] });
    config.get.mockImplementation((key: string) => {
      if (key === 'simulation.rpcUrls.8453') return 'http://insecure.example.invalid';
      return undefined;
    });
    const unknownDto = {
      ...dto,
      interactions: [{ to: TOKEN, data: erc20ApproveData(EXTERNAL, 100n), value: '0' }],
      idempotencyKey: 'debt-http-rpc-1',
    };

    await expect(service.send('user-1', unknownDto as any, apiKeyContext)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE },
    });
    expect(transactionSimulation.simulateAssetFlowEvidence).not.toHaveBeenCalled();
  });

  it('debt + unknown runs evidence simulation+verifier and rejects production unknown', async () => {
    billingDebt.getDebt.mockResolvedValue({ hasDebt: true, invoiceIds: ['inv-1'] });
    const unknownDto = {
      ...dto,
      interactions: [{ to: TOKEN, data: erc20ApproveData(EXTERNAL, 100n), value: '0' }],
      idempotencyKey: 'debt-unknown-1',
    };
    transactionSimulation.simulateAssetFlowEvidence.mockResolvedValue(
      mockProductionEvidence({
        interactions: unknownDto.interactions,
        ownerAddress: wallet.walletAddress,
      }),
    );

    await expect(service.send('user-1', unknownDto as any, apiKeyContext)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE },
    });

    expect(transactionSimulation.simulateAssetFlowEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        rpcUrl: SIM_RPC,
        ownerAddress: wallet.walletAddress,
        chainId: 8453,
        executionMode: 'session_key',
        interactions: unknownDto.interactions,
      }),
    );
    expect(mockVerifyTransactionAssetFlow).toHaveBeenCalled();
    expect(transactionSimulation.assertSimulatable).not.toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('debt + retained runs evidence path and rejects production non-atomic unknown', async () => {
    billingDebt.getDebt.mockResolvedValue({ hasDebt: true, invoiceIds: ['inv-1'] });
    const retainedDto = {
      ...dto,
      interactions: [
        { to: AAVE_POOL_8453, data: aaveSupplyData(wallet.walletAddress), value: '0' },
      ],
      idempotencyKey: 'debt-retained-prod-1',
    };
    transactionSimulation.simulateAssetFlowEvidence.mockResolvedValue(
      mockProductionEvidence({
        interactions: retainedDto.interactions,
        ownerAddress: wallet.walletAddress,
      }),
    );

    await expect(service.send('user-1', retainedDto as any, apiKeyContext)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE },
    });

    expect(transactionSimulation.simulateAssetFlowEvidence).toHaveBeenCalled();
    expect(mockVerifyTransactionAssetFlow).toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('allows debt path only with synthetic verified proof bound to exact plan', async () => {
    billingDebt.getDebt.mockResolvedValue({ hasDebt: true, invoiceIds: ['inv-1'] });
    const retainedDto = {
      ...dto,
      interactions: [
        { to: AAVE_POOL_8453, data: aaveSupplyData(wallet.walletAddress), value: '0' },
      ],
      idempotencyKey: 'debt-retained-verified-1',
    };
    const evidence = mockProductionEvidence({
      interactions: retainedDto.interactions,
      ownerAddress: wallet.walletAddress,
    });
    transactionSimulation.simulateAssetFlowEvidence.mockResolvedValue(evidence);
    mockVerifyTransactionAssetFlow.mockReturnValue(
      mockVerifiedVerdict({
        interactions: retainedDto.interactions,
        ownerAddress: wallet.walletAddress,
      }),
    );

    const result = await service.send('user-1', retainedDto as any, apiKeyContext);

    expect(result).toEqual({
      transactionId: 'tx-1',
      transactionHash: '0xhash',
      status: 'confirmed',
    });
    expect(transactionSimulation.simulateAssetFlowEvidence).toHaveBeenCalledTimes(1);
    expect(mockVerifyTransactionAssetFlow).toHaveBeenCalledTimes(1);
    expect(transactionSimulation.assertSimulatable).toHaveBeenCalled();
    expect(prisma.transaction.create).toHaveBeenCalled();
    expect(openfort.sendUserOperation).toHaveBeenCalled();
  });

  it('fail-closes when simulation RPC is missing under debt', async () => {
    billingDebt.getDebt.mockResolvedValue({ hasDebt: true, invoiceIds: ['inv-1'] });
    config.get.mockReturnValue(undefined);
    const unknownDto = {
      ...dto,
      interactions: [{ to: TOKEN, data: erc20ApproveData(EXTERNAL, 100n), value: '0' }],
      idempotencyKey: 'debt-missing-rpc-1',
    };

    await expect(service.send('user-1', unknownDto as any, apiKeyContext)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE },
    });
    expect(transactionSimulation.simulateAssetFlowEvidence).not.toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it('fail-closes when evidence simulation provider fails under debt', async () => {
    billingDebt.getDebt.mockResolvedValue({ hasDebt: true, invoiceIds: ['inv-1'] });
    transactionSimulation.simulateAssetFlowEvidence.mockRejectedValue(
      new AssetFlowSimulationUnavailableError(),
    );
    const unknownDto = {
      ...dto,
      interactions: [{ to: TOKEN, data: erc20ApproveData(EXTERNAL, 100n), value: '0' }],
      idempotencyKey: 'debt-sim-fail-1',
    };

    await expect(service.send('user-1', unknownDto as any, apiKeyContext)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE },
    });
    expect(mockVerifyTransactionAssetFlow).not.toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it('fail-closes when verifier reports external_transfer under debt', async () => {
    billingDebt.getDebt.mockResolvedValue({ hasDebt: true, invoiceIds: ['inv-1'] });
    const unknownDto = {
      ...dto,
      interactions: [{ to: TOKEN, data: erc20ApproveData(EXTERNAL, 100n), value: '0' }],
      idempotencyKey: 'debt-verify-external-1',
    };
    transactionSimulation.simulateAssetFlowEvidence.mockResolvedValue(
      mockProductionEvidence({
        interactions: unknownDto.interactions,
        ownerAddress: wallet.walletAddress,
      }),
    );
    mockVerifyTransactionAssetFlow.mockReturnValue({
      status: 'external_transfer',
      rule: 'sim_external',
      reason: 'outflow',
      simulationMode: 'calibur_atomic',
      block: null,
    });

    await expect(service.send('user-1', unknownDto as any, apiKeyContext)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.BILLING_OUTBOUND_BLOCKED },
    });
    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it('preserves no-debt external_transfer without evidence simulation', async () => {
    billingDebt.getDebt.mockResolvedValue({ hasDebt: false, invoiceIds: [] });
    const externalDto = {
      ...dto,
      interactions: [{ to: TOKEN, data: erc20TransferData(EXTERNAL), value: '0' }],
      idempotencyKey: 'no-debt-external-1',
    };

    const result = await service.send('user-1', externalDto as any, apiKeyContext);

    expect(result.transactionId).toBe('tx-1');
    expect(transactionSimulation.simulateAssetFlowEvidence).not.toHaveBeenCalled();
    expect(mockVerifyTransactionAssetFlow).not.toHaveBeenCalled();
    expect(transactionSimulation.assertSimulatable).toHaveBeenCalled();
    expect(prisma.transaction.create).toHaveBeenCalled();
    expect(openfort.sendUserOperation).toHaveBeenCalled();
  });

  it('classifies EOA sends with agentWalletAddress as evidence owner', async () => {
    billingDebt.getDebt.mockResolvedValue({ hasDebt: true, invoiceIds: ['inv-1'] });
    const retainedToAgent = {
      ...dto,
      executionMode: 'eoa' as const,
      interactions: [
        { to: AAVE_POOL_8453, data: aaveSupplyData(wallet.agentWalletAddress), value: '0' },
      ],
      idempotencyKey: 'eoa-retained-1',
    };
    transactionSimulation.simulateAssetFlowEvidence.mockResolvedValue(
      mockProductionEvidence({
        interactions: retainedToAgent.interactions,
        ownerAddress: wallet.agentWalletAddress,
        executionMode: 'eoa',
      }),
    );
    mockVerifyTransactionAssetFlow.mockReturnValue(
      mockVerifiedVerdict({
        interactions: retainedToAgent.interactions,
        ownerAddress: wallet.agentWalletAddress,
        executionMode: 'eoa',
      }),
    );

    await expect(
      service.send('user-1', retainedToAgent as any, {
        ...apiKeyContext,
        canUseEoaExecution: true,
      }),
    ).resolves.toEqual(expect.objectContaining({ transactionId: 'tx-1' }));

    expect(transactionSimulation.simulateAssetFlowEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerAddress: wallet.agentWalletAddress,
        executionMode: 'eoa',
      }),
    );

    billingDebt.getDebt.mockResolvedValue({ hasDebt: true, invoiceIds: ['inv-1'] });
    const externalFromEoa = {
      ...dto,
      executionMode: 'eoa' as const,
      interactions: [{ to: TOKEN, data: erc20TransferData(wallet.walletAddress), value: '0' }],
      idempotencyKey: 'eoa-external-1',
    };
    await expect(
      service.send('user-1', externalFromEoa as any, {
        ...apiKeyContext,
        canUseEoaExecution: true,
      }),
    ).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.BILLING_OUTBOUND_BLOCKED },
    });
    // Second call is static external — no additional evidence simulation.
    expect(openfort.sendBackendTransaction).toHaveBeenCalledTimes(1);
  });

  it('bypasses classifier/debt/evidence gate on idempotent hit', async () => {
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-existing',
      status: 'pending',
      txHash: null,
    });
    billingDebt.getDebt.mockResolvedValue({ hasDebt: true, invoiceIds: ['inv-1'] });

    const result = await service.send(
      'user-1',
      {
        ...dto,
        interactions: [{ to: TOKEN, data: erc20TransferData(EXTERNAL), value: '0' }],
      } as any,
      apiKeyContext,
    );

    expect(result).toEqual({
      transactionId: 'tx-existing',
      transactionHash: null,
      status: 'pending',
    });
    expect(billingDebt.getDebt).not.toHaveBeenCalled();
    expect(transactionSimulation.simulateAssetFlowEvidence).not.toHaveBeenCalled();
    expect(transactionSimulation.assertSimulatable).not.toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('inner recheck rejects when outer had no debt but inner finds debt without proof', async () => {
    billingDebt.getDebt
      .mockResolvedValueOnce({ hasDebt: false, invoiceIds: [] })
      .mockResolvedValueOnce({ hasDebt: true, invoiceIds: ['inv-race'] });
    const externalDto = {
      ...dto,
      interactions: [{ to: TOKEN, data: erc20TransferData(EXTERNAL), value: '0' }],
      idempotencyKey: 'debt-tx-recheck-1',
    };

    await expect(service.send('user-1', externalDto as any, apiKeyContext)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE },
    });

    expect(billingDebt.getDebt).toHaveBeenCalledTimes(2);
    expect(transactionSimulation.simulateAssetFlowEvidence).not.toHaveBeenCalled();
    expect(transactionSimulation.assertSimulatable).toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('inner recheck accepts outer debt with bound verified proof without RPC', async () => {
    billingDebt.getDebt.mockResolvedValue({ hasDebt: true, invoiceIds: ['inv-1'] });
    const retainedDto = {
      ...dto,
      interactions: [
        { to: AAVE_POOL_8453, data: aaveSupplyData(wallet.walletAddress), value: '0' },
      ],
      idempotencyKey: 'debt-inner-bound-1',
    };
    transactionSimulation.simulateAssetFlowEvidence.mockResolvedValue(
      mockProductionEvidence({
        interactions: retainedDto.interactions,
        ownerAddress: wallet.walletAddress,
      }),
    );
    mockVerifyTransactionAssetFlow.mockReturnValue(
      mockVerifiedVerdict({
        interactions: retainedDto.interactions,
        ownerAddress: wallet.walletAddress,
      }),
    );

    await expect(service.send('user-1', retainedDto as any, apiKeyContext)).resolves.toEqual(
      expect.objectContaining({ transactionId: 'tx-1' }),
    );

    // Outer sim once; inner must not call simulation again.
    expect(transactionSimulation.simulateAssetFlowEvidence).toHaveBeenCalledTimes(1);
    expect(billingDebt.getDebt).toHaveBeenCalledTimes(2);
    expect(prisma.transaction.create).toHaveBeenCalled();
  });

  it('inner recheck rejects when bound proof plan digest no longer matches interactions', async () => {
    billingDebt.getDebt.mockResolvedValue({ hasDebt: true, invoiceIds: ['inv-1'] });
    const interactions = [
      { to: AAVE_POOL_8453, data: aaveSupplyData(wallet.walletAddress), value: '0' },
    ];
    const retainedDto = {
      ...dto,
      interactions,
      idempotencyKey: 'debt-digest-mismatch-1',
    };
    // Evidence/digest for a different plan than the request will carry.
    transactionSimulation.simulateAssetFlowEvidence.mockResolvedValue(
      mockProductionEvidence({
        interactions: [{ to: TOKEN, data: erc20ApproveData(EXTERNAL, 1n), value: '0' }],
        ownerAddress: wallet.walletAddress,
      }),
    );
    mockVerifyTransactionAssetFlow.mockReturnValue({
      status: 'verified',
      rule: 'test_verified',
      reason: 'synthetic',
      simulationMode: 'calibur_atomic',
      block: null,
    });

    await expect(service.send('user-1', retainedDto as any, apiKeyContext)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE },
    });
    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it('inner recheck rejects when bound proof owner/mode/chain mismatch', async () => {
    billingDebt.getDebt.mockResolvedValue({ hasDebt: true, invoiceIds: ['inv-1'] });
    const interactions = [
      { to: AAVE_POOL_8453, data: aaveSupplyData(wallet.walletAddress), value: '0' },
    ];
    const retainedDto = {
      ...dto,
      interactions,
      idempotencyKey: 'debt-owner-mismatch-1',
    };
    const wrongOwner = '0x3333333333333333333333333333333333333333';
    transactionSimulation.simulateAssetFlowEvidence.mockResolvedValue(
      mockProductionEvidence({
        interactions,
        ownerAddress: wrongOwner,
      }),
    );
    mockVerifyTransactionAssetFlow.mockReturnValue({
      status: 'verified',
      rule: 'test_verified',
      reason: 'synthetic',
      simulationMode: 'calibur_atomic',
      block: null,
    });

    await expect(service.send('user-1', retainedDto as any, apiKeyContext)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE },
    });
    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it('rejects full interaction reorder against bound plan digest', async () => {
    billingDebt.getDebt.mockResolvedValue({ hasDebt: true, invoiceIds: ['inv-1'] });
    const a = { to: AAVE_POOL_8453, data: aaveSupplyData(wallet.walletAddress), value: '0' };
    const b = { to: TOKEN, data: erc20ApproveData(EXTERNAL, 1n), value: '0' };
    const orderedDto = {
      ...dto,
      interactions: [a, b],
      idempotencyKey: 'debt-reorder-1',
    };
    // Evidence sealed for reverse order.
    transactionSimulation.simulateAssetFlowEvidence.mockResolvedValue(
      mockProductionEvidence({
        interactions: [b, a],
        ownerAddress: wallet.walletAddress,
      }),
    );
    mockVerifyTransactionAssetFlow.mockReturnValue({
      status: 'verified',
      rule: 'test_verified',
      reason: 'synthetic',
      simulationMode: 'calibur_atomic',
      block: null,
    });

    await expect(service.send('user-1', orderedDto as any, apiKeyContext)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE },
    });
    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it('rejects mock verified + eth_simulateV1_non_atomic (outer defense-in-depth)', async () => {
    billingDebt.getDebt.mockResolvedValue({ hasDebt: true, invoiceIds: ['inv-1'] });
    const interactions = [
      { to: AAVE_POOL_8453, data: aaveSupplyData(wallet.walletAddress), value: '0' },
    ];
    const retainedDto = {
      ...dto,
      interactions,
      idempotencyKey: 'debt-non-atomic-verified-1',
    };
    transactionSimulation.simulateAssetFlowEvidence.mockResolvedValue(
      mockProductionEvidence({
        interactions,
        ownerAddress: wallet.walletAddress,
      }),
    );
    mockVerifyTransactionAssetFlow.mockReturnValue({
      status: 'verified',
      rule: 'spoofed_verified',
      reason: 'mock non-atomic verified',
      simulationMode: 'eth_simulateV1_non_atomic',
      block: null,
    });

    await expect(service.send('user-1', retainedDto as any, apiKeyContext)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE },
    });
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('rejects evidence with missing binding even when verifier returns calibur_atomic verified', async () => {
    billingDebt.getDebt.mockResolvedValue({ hasDebt: true, invoiceIds: ['inv-1'] });
    const interactions = [
      { to: AAVE_POOL_8453, data: aaveSupplyData(wallet.walletAddress), value: '0' },
    ];
    const retainedDto = {
      ...dto,
      interactions,
      idempotencyKey: 'debt-missing-binding-1',
    };
    const evidence = mockProductionEvidence({
      interactions,
      ownerAddress: wallet.walletAddress,
    });
    delete (evidence as any).binding;
    transactionSimulation.simulateAssetFlowEvidence.mockResolvedValue(evidence);
    mockVerifyTransactionAssetFlow.mockReturnValue(
      mockVerifiedVerdict({
        interactions,
        ownerAddress: wallet.walletAddress,
      }),
    );

    await expect(service.send('user-1', retainedDto as any, apiKeyContext)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE },
    });
    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it('rejects evidence binding missing planDigest without context fallback', async () => {
    billingDebt.getDebt.mockResolvedValue({ hasDebt: true, invoiceIds: ['inv-1'] });
    const interactions = [
      { to: AAVE_POOL_8453, data: aaveSupplyData(wallet.walletAddress), value: '0' },
    ];
    const retainedDto = {
      ...dto,
      interactions,
      idempotencyKey: 'debt-missing-digest-field-1',
    };
    const evidence = mockProductionEvidence({
      interactions,
      ownerAddress: wallet.walletAddress,
    });
    (evidence.binding as any).planDigest = '';
    transactionSimulation.simulateAssetFlowEvidence.mockResolvedValue(evidence);
    mockVerifyTransactionAssetFlow.mockReturnValue(
      mockVerifiedVerdict({
        interactions,
        ownerAddress: wallet.walletAddress,
      }),
    );

    await expect(service.send('user-1', retainedDto as any, apiKeyContext)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE },
    });
    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it('rejects evidence binding chainId mismatch without context fallback', async () => {
    billingDebt.getDebt.mockResolvedValue({ hasDebt: true, invoiceIds: ['inv-1'] });
    const interactions = [
      { to: AAVE_POOL_8453, data: aaveSupplyData(wallet.walletAddress), value: '0' },
    ];
    const retainedDto = {
      ...dto,
      interactions,
      idempotencyKey: 'debt-binding-chain-mismatch-1',
    };
    const evidence = mockProductionEvidence({
      interactions,
      ownerAddress: wallet.walletAddress,
    });
    (evidence.binding as any).chainId = 1;
    transactionSimulation.simulateAssetFlowEvidence.mockResolvedValue(evidence);
    mockVerifyTransactionAssetFlow.mockReturnValue(
      mockVerifiedVerdict({
        interactions,
        ownerAddress: wallet.walletAddress,
      }),
    );

    await expect(service.send('user-1', retainedDto as any, apiKeyContext)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE },
    });
    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it('rejects evidence binding executionMode mismatch without context fallback', async () => {
    billingDebt.getDebt.mockResolvedValue({ hasDebt: true, invoiceIds: ['inv-1'] });
    const interactions = [
      { to: AAVE_POOL_8453, data: aaveSupplyData(wallet.walletAddress), value: '0' },
    ];
    const retainedDto = {
      ...dto,
      interactions,
      idempotencyKey: 'debt-binding-mode-mismatch-1',
    };
    const evidence = mockProductionEvidence({
      interactions,
      ownerAddress: wallet.walletAddress,
      executionMode: 'session_key',
    });
    (evidence.binding as any).executionMode = 'eoa';
    transactionSimulation.simulateAssetFlowEvidence.mockResolvedValue(evidence);
    mockVerifyTransactionAssetFlow.mockReturnValue(
      mockVerifiedVerdict({
        interactions,
        ownerAddress: wallet.walletAddress,
      }),
    );

    await expect(service.send('user-1', retainedDto as any, apiKeyContext)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE },
    });
    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it('accepts exact calibur_atomic binding and inner recheck does not RPC', async () => {
    billingDebt.getDebt.mockResolvedValue({ hasDebt: true, invoiceIds: ['inv-1'] });
    const interactions = [
      { to: AAVE_POOL_8453, data: aaveSupplyData(wallet.walletAddress), value: '0' },
    ];
    const retainedDto = {
      ...dto,
      interactions,
      idempotencyKey: 'debt-calibur-exact-1',
    };
    transactionSimulation.simulateAssetFlowEvidence.mockResolvedValue(
      mockProductionEvidence({
        interactions,
        ownerAddress: wallet.walletAddress,
      }),
    );
    mockVerifyTransactionAssetFlow.mockReturnValue(
      mockVerifiedVerdict({
        interactions,
        ownerAddress: wallet.walletAddress,
      }),
    );

    await expect(service.send('user-1', retainedDto as any, apiKeyContext)).resolves.toEqual(
      expect.objectContaining({ transactionId: 'tx-1', status: 'confirmed' }),
    );
    expect(transactionSimulation.simulateAssetFlowEvidence).toHaveBeenCalledTimes(1);
    expect(billingDebt.getDebt).toHaveBeenCalledTimes(2);
    expect(prisma.transaction.create).toHaveBeenCalled();
    expect(openfort.sendUserOperation).toHaveBeenCalled();
  });

  it('returns 503 when billing debt check fails (fail-closed)', async () => {
    billingDebt.getDebt.mockRejectedValue(new Error('db unavailable'));

    await expect(service.send('user-1', dto as any, apiKeyContext)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.BILLING_DEBT_CHECK_UNAVAILABLE },
    });
    await expect(service.send('user-1', dto as any, apiKeyContext)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(transactionSimulation.simulateAssetFlowEvidence).not.toHaveBeenCalled();
    expect(transactionSimulation.assertSimulatable).not.toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });
});
