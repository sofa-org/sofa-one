import {
  BadRequestException,
  ForbiddenException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { encodeAbiParameters, hashMessage, hashTypedData, type Hex } from 'viem';

// ── viem mock ──────────────────────────────────────────────────────────────────
// Must be declared before any imports that pull in viem transitively.
const mockReadContract = jest.fn();
const mockGetBalance = jest.fn();

jest.mock('viem', () => {
  const actual = jest.requireActual<typeof import('viem')>('viem');
  return {
    ...actual,
    createPublicClient: jest.fn(() => ({
      readContract: mockReadContract,
      getBalance: mockGetBalance,
    })),
  };
});

jest.mock('../../core/openfort/openfort.service', () => ({
  OpenfortService: class OpenfortService {},
}));

// ── service imports (after mock) ───────────────────────────────────────────────
import { WalletService } from './wallet.service';
import { PrismaService } from '../../core/database/prisma.service';
import { OpenfortService } from '../../core/openfort/openfort.service';
import { getSupportedChain } from '../../common/chains/supported-chains';
import { hashRequest } from '../../common/utils/request-hash';
import type { WithdrawDto } from './dto/withdraw.dto';
import { WithdrawalPolicyService } from './withdrawal-policy.service';
import { EoaExecutionPolicyService } from '../eoa-execution/eoa-execution-policy.service';
import { SigningPolicyService } from './signing-policy.service';
import { SecurityEventService } from '../security-events/security-event.service';
import { RiskEvaluationService } from '../security-events/risk-evaluation.service';

// ── helpers ────────────────────────────────────────────────────────────────────

const WALLET = {
  id: 'wallet-1',
  userId: 'user-1',
  walletAddress: '0xABCDEF1234567890ABCDEf1234567890abcdef12',
  openfortAccountId: 'acc-1',
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

const VALID_DTO: WithdrawDto = {
  chainId: 84532,
  to: '0x1111111111111111111111111111111111111111',
  amount: '1000000', // 1 USDC
  token: 'USDC',
  idempotencyKey: 'idem-key-123',
};

// Sufficient balance (2 USDC in micro-units)
const SUFFICIENT_BALANCE = BigInt('2000000');
const API_KEY_PREFIX = 'sk_1234567890abcdef12345678';
const API_KEY_CONTEXT = {
  id: 'api-key-1',
  keyPrefix: API_KEY_PREFIX,
  name: 'Production key',
  allowedIps: ['203.0.113.10'],
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  canSign: true,
  canUseEoaExecution: false,
};
const RAW_SIGNATURE = `0x${'11'.repeat(32)}${'22'.repeat(32)}1b` as const;
const WRAPPED_SIGNATURE = encodeAbiParameters(
  [
    { name: 'keyHash', type: 'bytes32' },
    { name: 'signature', type: 'bytes' },
    { name: 'hookData', type: 'bytes' },
  ],
  [WALLET.agentKeyHash as Hex, RAW_SIGNATURE, '0x'],
);

// ── test suite ─────────────────────────────────────────────────────────────────

describe('WalletService.withdraw()', () => {
  let service: WalletService;

  // Prisma mock handles
  const mockFindUnique = jest.fn();
  const mockFindFirst = jest.fn();
  const mockCreate = jest.fn();
  const mockUpdate = jest.fn();
  const mockAssertWithdrawalAllowed = jest.fn();
  const mockEvaluateRisk = jest.fn();
  const mockEnforceRiskAction = jest.fn();

  // Openfort mock handle
  const mockSendUserOperation = jest.fn();
  let loggerWarnSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    loggerWarnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    // Default: wallet exists, sufficient balance, no duplicate tx
    mockFindUnique.mockResolvedValue({ ...WALLET });
    mockFindFirst.mockResolvedValue(null);
    mockReadContract.mockResolvedValue(SUFFICIENT_BALANCE);
    mockSendUserOperation.mockResolvedValue({ userOpHash: '0xuserop', transactionHash: '0xhash' });
    mockCreate.mockResolvedValue({ id: 'tx-1', txHash: null, status: 'submitting' });
    mockUpdate.mockResolvedValue({ id: 'tx-1', txHash: '0xhash', status: 'pending' });
    mockAssertWithdrawalAllowed.mockResolvedValue(undefined);
    mockEvaluateRisk.mockResolvedValue({
      riskLevel: 'low',
      score: 0,
      action: 'allow',
      factors: [],
      reason: 'No risk factors detected',
    });
    mockEnforceRiskAction.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        {
          provide: PrismaService,
          useValue: {
            userWallet: { findUnique: mockFindUnique },
            transaction: { findFirst: mockFindFirst, create: mockCreate, update: mockUpdate },
          },
        },
        {
          provide: OpenfortService,
          useValue: { sendUserOperation: mockSendUserOperation, signData: jest.fn() },
        },
        {
          provide: WithdrawalPolicyService,
          useValue: { assertWithdrawalAllowed: mockAssertWithdrawalAllowed },
        },
        {
          provide: RiskEvaluationService,
          useValue: { evaluateRisk: mockEvaluateRisk, enforceRiskAction: mockEnforceRiskAction },
        },
      ],
    }).compile();

    service = module.get<WalletService>(WalletService);
  });

  afterEach(() => {
    loggerWarnSpy.mockRestore();
  });

  // ── 1. Wallet not found ──────────────────────────────────────────────────────

  it('throws NotFoundException when wallet not found', async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toThrow(NotFoundException);
  });

  // ── 2. Wallet not active ─────────────────────────────────────────────────────

  it('throws BadRequestException when wallet status is suspended', async () => {
    mockFindUnique.mockResolvedValue({ ...WALLET, status: 'suspended' });

    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toThrow(BadRequestException);

    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toThrow(/not active/i);
  });

  it('rejects frozen wallets before withdrawal policy or balance checks', async () => {
    mockFindUnique.mockResolvedValue({
      ...WALLET,
      frozenAt: new Date('2026-05-28T00:00:00.000Z'),
      frozenReason: 'security_review',
    });

    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toThrow(ForbiddenException);
    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toThrow('security_review');
    expect(mockAssertWithdrawalAllowed).not.toHaveBeenCalled();
    expect(mockReadContract).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // ── 3. Self-withdrawal ───────────────────────────────────────────────────────

  it('throws BadRequestException when `to` equals wallet address (case-insensitive)', async () => {
    const selfDto: WithdrawDto = {
      ...VALID_DTO,
      // uppercase version of the wallet address
      to: WALLET.walletAddress.toUpperCase() as `0x${string}`,
    };

    await expect(service.withdraw('user-1', selfDto)).rejects.toThrow(BadRequestException);

    await expect(service.withdraw('user-1', selfDto)).rejects.toThrow(
      'Cannot withdraw to your own wallet address',
    );
  });

  // ── 4. Idempotency duplicate ─────────────────────────────────────────────────

  it('returns the existing withdrawal when idempotencyKey was already submitted', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'tx-existing',
      txHash: '0xhash-existing',
      status: 'pending',
    });

    const result = await service.withdraw('user-1', VALID_DTO);

    expect(result).toEqual({
      transactionId: 'tx-existing',
      transactionHash: '0xhash-existing',
      status: 'pending',
    });
    expect(mockReadContract).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSendUserOperation).not.toHaveBeenCalled();
  });

  it('returns the in-progress withdrawal when idempotencyKey is already submitting', async () => {
    mockFindFirst.mockResolvedValue({ id: 'tx-existing', txHash: null, status: 'submitting' });

    const result = await service.withdraw('user-1', VALID_DTO);

    expect(result).toEqual({
      transactionId: 'tx-existing',
      transactionHash: null,
      status: 'submitting',
    });
    expect(mockReadContract).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSendUserOperation).not.toHaveBeenCalled();
  });

  it('returns the existing withdrawal after a concurrent idempotency insert race', async () => {
    mockFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'tx-existing', txHash: null, status: 'submitting' });
    mockCreate.mockRejectedValue({ code: 'P2002' });

    const result = await service.withdraw('user-1', VALID_DTO);

    expect(result).toEqual({
      transactionId: 'tx-existing',
      transactionHash: null,
      status: 'submitting',
    });
    expect(mockReadContract).toHaveBeenCalledTimes(1);
    expect(mockSendUserOperation).not.toHaveBeenCalled();
  });

  it('rejects withdrawal idempotency reuse with a different request before balance checks', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'tx-existing',
      txHash: '0xhash-existing',
      status: 'pending',
      requestHash: 'different-request',
    });

    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toThrow(BadRequestException);

    expect(mockReadContract).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSendUserOperation).not.toHaveBeenCalled();
  });

  it('rejects withdrawals above the single-withdrawal limit before balance checks', async () => {
    mockAssertWithdrawalAllowed.mockRejectedValue(
      new BadRequestException('Withdrawal amount exceeds single-withdrawal limit'),
    );

    await expect(
      service.withdraw('user-1', {
        ...VALID_DTO,
        amount: '10000000001',
      }),
    ).rejects.toThrow('Withdrawal amount exceeds single-withdrawal limit');

    expect(mockReadContract).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSendUserOperation).not.toHaveBeenCalled();
    expect(mockAssertWithdrawalAllowed).toHaveBeenCalledTimes(1);
  });

  it('logs high-value withdrawals without blocking allowed amounts', async () => {
    mockReadContract.mockResolvedValue(BigInt('2000000000'));

    await service.withdraw('user-1', {
      ...VALID_DTO,
      amount: '1000000000',
    });

    expect(mockAssertWithdrawalAllowed).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ amount: '1000000000' }),
      expect.objectContaining({
        chainId: VALID_DTO.chainId,
        walletAddress: WALLET.walletAddress,
      }),
    );
    expect(JSON.stringify(loggerWarnSpy.mock.calls)).not.toContain(VALID_DTO.to);
    expect(mockSendUserOperation).toHaveBeenCalledTimes(1);
  });

  it('does not re-require step-up when dashboard withdrawal risk is medium and step-up is verified', async () => {
    mockEvaluateRisk.mockResolvedValue({
      riskLevel: 'medium',
      score: 30,
      action: 'require_step_up',
      factors: [
        {
          category: 'identity',
          name: 'consecutive_auth_failures',
          weight: 30,
          description: '3 authentication failures in the last hour',
        },
      ],
      reason: 'consecutive_auth_failures(30)',
    });

    await service.withdraw('user-1', VALID_DTO, { stepUpVerified: true });

    expect(mockEnforceRiskAction).not.toHaveBeenCalled();
    expect(mockSendUserOperation).toHaveBeenCalledTimes(1);
  });

  it('requires step-up when dashboard withdrawal risk is medium and step-up is not verified', async () => {
    const assessment = {
      riskLevel: 'medium',
      score: 30,
      action: 'require_step_up',
      factors: [
        {
          category: 'identity',
          name: 'consecutive_auth_failures',
          weight: 30,
          description: '3 authentication failures in the last hour',
        },
      ],
      reason: 'consecutive_auth_failures(30)',
    };
    mockEvaluateRisk.mockResolvedValue(assessment);
    mockEnforceRiskAction.mockRejectedValue(
      new ForbiddenException('Additional verification required'),
    );

    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toThrow(ForbiddenException);

    expect(mockEnforceRiskAction).toHaveBeenCalledWith(assessment, {
      userId: 'user-1',
      walletId: WALLET.id,
      operationType: 'withdrawal',
    });
    expect(mockReadContract).not.toHaveBeenCalled();
    expect(mockSendUserOperation).not.toHaveBeenCalled();
  });

  // ── 5. Insufficient USDC balance ─────────────────────────────────────────────

  it('throws BadRequestException when USDC balance is insufficient', async () => {
    // Balance: 0.5 USDC (500_000 units) < requested 1 USDC (1_000_000 units)
    mockReadContract.mockResolvedValue(BigInt('500000'));

    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toThrow(BadRequestException);

    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toThrow(
      /Insufficient USDC balance/i,
    );
  });

  // ── 6. Balance fetch fails ───────────────────────────────────────────────────

  it('throws BadRequestException when readContract throws during balance check', async () => {
    mockReadContract.mockRejectedValue(new Error('RPC error'));

    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toThrow(BadRequestException);

    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toThrow(
      /Unable to verify USDC balance/i,
    );
  });

  // ── 7. Happy path ─────────────────────────────────────────────────────────────

  it('calls openfort and prisma, returns correct shape on success', async () => {
    const result = await service.withdraw('user-1', VALID_DTO);

    // Openfort intent was created
    expect(mockSendUserOperation).toHaveBeenCalledTimes(1);
    expect(mockSendUserOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: VALID_DTO.chainId,
        accountAddress: WALLET.walletAddress,
        agentAccountId: WALLET.agentOpenfortAccountId,
        keyHash: WALLET.agentKeyHash,
        interactions: [
          expect.objectContaining({
            to: expect.any(String),
            data: expect.stringMatching(/^0x/),
            value: '0',
          }),
        ],
      }),
    );

    // Prisma transaction was persisted
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // Return shape
    expect(result).toEqual({
      transactionId: 'tx-1',
      transactionHash: '0xhash',
      status: 'pending',
    });
  });

  // ── 8. Happy path with idempotencyKey ────────────────────────────────────────

  it('stores idempotencyKey in dedicated columns and details', async () => {
    const dto: WithdrawDto = { ...VALID_DTO, idempotencyKey: 'unique-key-abc' };
    await service.withdraw('user-1', dto);

    const createCall = mockCreate.mock.calls[0][0] as {
      data: { idempotencyKey: string; operationType: string; details: Record<string, unknown> };
    };
    expect(createCall.data.operationType).toBe('withdraw');
    expect(createCall.data.idempotencyKey).toBe('unique-key-abc');
    expect(createCall.data.details).toMatchObject({ idempotencyKey: 'unique-key-abc' });
  });

  it('marks the pre-created withdrawal failed when Openfort submission fails', async () => {
    mockSendUserOperation.mockRejectedValue(new Error('Openfort down'));

    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toThrow('Openfort down');
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'tx-1' },
      data: { status: 'unknown' },
    });
  });
});

describe('WalletService.sign()', () => {
  let service: WalletService;

  const mockFindUnique = jest.fn();
  const mockSignData = jest.fn();
  const mockVerifyAgentKeyRegistration = jest.fn();
  const mockSigningRequestCreate = jest.fn();
  const mockSigningRequestUpdate = jest.fn();
  const mockAssertEoaExecutionAllowed = jest.fn();
  let loggerErrorSpy: jest.SpyInstance;
  let loggerWarnSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    loggerErrorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    loggerWarnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    mockFindUnique.mockResolvedValue({ ...WALLET });
    mockVerifyAgentKeyRegistration.mockResolvedValue(undefined);
    mockSignData.mockResolvedValue(RAW_SIGNATURE);
    mockSigningRequestCreate.mockResolvedValue({ id: 'signing-request-1' });
    mockSigningRequestUpdate.mockResolvedValue({ id: 'signing-request-1', status: 'signed' });
    mockAssertEoaExecutionAllowed.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        {
          provide: PrismaService,
          useValue: {
            userWallet: { findUnique: mockFindUnique },
            signingRequest: { create: mockSigningRequestCreate, update: mockSigningRequestUpdate },
          },
        },
        {
          provide: OpenfortService,
          useValue: {
            signData: mockSignData,
            verifyAgentKeyRegistration: mockVerifyAgentKeyRegistration,
          },
        },
        {
          provide: EoaExecutionPolicyService,
          useValue: { assertAllowed: mockAssertEoaExecutionAllowed },
        },
        {
          provide: SecurityEventService,
          useValue: { record: jest.fn().mockResolvedValue({}) },
        },
        {
          provide: WithdrawalPolicyService,
          useValue: {
            assertWithdrawalAllowed: jest.fn().mockResolvedValue(undefined),
            listWithdrawalAddresses: jest.fn(),
            addWithdrawalAddress: jest.fn(),
            removeWithdrawalAddress: jest.fn(),
          },
        },
        SigningPolicyService,
      ],
    }).compile();

    service = module.get<WalletService>(WalletService);
  });

  afterEach(() => {
    loggerErrorSpy.mockRestore();
    loggerWarnSpy.mockRestore();
  });

  it('uses EIP-191 hash for message signing', async () => {
    const result = await service.sign(
      'user-1',
      { type: 'message', message: 'Hello, SOFA ONE!', chainId: 84532 } as any,
      API_KEY_CONTEXT,
    );

    expect(mockSignData).toHaveBeenCalledWith(
      WALLET.agentOpenfortAccountId,
      hashMessage('Hello, SOFA ONE!'),
    );
    expect(mockVerifyAgentKeyRegistration).toHaveBeenCalledWith({
      accountAddress: WALLET.walletAddress,
      chainId: 84532,
      keyHash: WALLET.agentKeyHash,
    });
    expect(result).toEqual({
      signature: WRAPPED_SIGNATURE,
      walletAddress: WALLET.walletAddress,
      type: 'message',
      executionMode: 'session_key',
    });
  });

  it('rejects frozen wallets before creating signing request', async () => {
    mockFindUnique.mockResolvedValue({
      ...WALLET,
      frozenAt: new Date('2026-05-28T00:00:00.000Z'),
      frozenReason: 'wallet_compromise',
    });

    await expect(
      service.sign(
        'user-1',
        { type: 'message', message: 'Hello, SOFA ONE!', chainId: 84532 } as any,
        API_KEY_CONTEXT,
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(mockSigningRequestCreate).not.toHaveBeenCalled();
    expect(mockSignData).not.toHaveBeenCalled();
  });

  it('uses the backend wallet raw signature and skips agent verification for eoa execution mode', async () => {
    const result = await service.sign(
      'user-1',
      { type: 'message', message: 'Hello, SOFA ONE!', chainId: 84532, executionMode: 'eoa' } as any,
      { ...API_KEY_CONTEXT, canUseEoaExecution: true },
    );

    expect(mockSignData).toHaveBeenCalledWith(
      WALLET.agentOpenfortAccountId,
      hashMessage('Hello, SOFA ONE!'),
    );
    expect(mockVerifyAgentKeyRegistration).not.toHaveBeenCalled();
    expect(mockAssertEoaExecutionAllowed).toHaveBeenCalledWith({
      operation: 'sign',
      userId: 'user-1',
      apiKeyId: 'api-key-1',
      apiKeyPrefix: API_KEY_PREFIX,
      allowedIps: ['203.0.113.10'],
      expiresAt: expect.any(Date),
      chainId: 84532,
      metadata: { type: 'message' },
    });
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'security',
        message: 'Privileged EOA signing requested',
        userId: 'user-1',
        chainId: 84532,
        type: 'message',
        executionMode: 'eoa',
        apiKeyPrefix: API_KEY_PREFIX,
      }),
    );
    expect(mockSigningRequestCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ walletAddress: WALLET.agentWalletAddress }),
    });
    expect(result).toEqual({
      signature: RAW_SIGNATURE,
      walletAddress: WALLET.agentWalletAddress,
      type: 'message',
      executionMode: 'eoa',
    });
  });

  it('rejects signing when the API key lacks sign permission', async () => {
    await expect(
      service.sign(
        'user-1',
        { type: 'message', message: 'Hello, SOFA ONE!', chainId: 84532 } as any,
        {
          ...API_KEY_CONTEXT,
          canSign: false,
        },
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockSigningRequestCreate).not.toHaveBeenCalled();
    expect(mockSignData).not.toHaveBeenCalled();
  });

  it('rejects typed data signing when the API key lacks sign permission', async () => {
    await expect(
      service.sign(
        'user-1',
        { type: 'typed_data', typedData: createTypedData(84532), chainId: 84532 } as any,
        { ...API_KEY_CONTEXT, canSign: false },
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockSigningRequestCreate).not.toHaveBeenCalled();
    expect(mockSignData).not.toHaveBeenCalled();
  });

  it('rejects eoa signing when the API key lacks eoa permission', async () => {
    await expect(
      service.sign(
        'user-1',
        {
          type: 'message',
          message: 'Hello, SOFA ONE!',
          chainId: 84532,
          executionMode: 'eoa',
        } as any,
        API_KEY_CONTEXT,
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockAssertEoaExecutionAllowed).not.toHaveBeenCalled();
    expect(mockSigningRequestCreate).not.toHaveBeenCalled();
    expect(mockSignData).not.toHaveBeenCalled();
  });

  it('rejects eoa signing when the EOA isolation policy denies the request', async () => {
    mockAssertEoaExecutionAllowed.mockRejectedValueOnce(
      new ForbiddenException('EOA execution is disabled'),
    );

    await expect(
      service.sign(
        'user-1',
        {
          type: 'message',
          message: 'Hello, SOFA ONE!',
          chainId: 84532,
          executionMode: 'eoa',
        } as any,
        { ...API_KEY_CONTEXT, canUseEoaExecution: true },
      ),
    ).rejects.toThrow('EOA execution is disabled');

    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockSigningRequestCreate).not.toHaveBeenCalled();
    expect(mockSignData).not.toHaveBeenCalled();
  });

  it('rejects typed data eoa signing when the API key lacks eoa permission', async () => {
    await expect(
      service.sign(
        'user-1',
        {
          type: 'typed_data',
          typedData: createTypedData(84532),
          chainId: 84532,
          executionMode: 'eoa',
        } as any,
        { ...API_KEY_CONTEXT, canUseEoaExecution: false },
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockSigningRequestCreate).not.toHaveBeenCalled();
    expect(mockSignData).not.toHaveBeenCalled();
  });

  it('audits a successful signing request without storing the plaintext message', async () => {
    await service.sign(
      'user-1',
      { type: 'message', message: 'Hello, SOFA ONE!', chainId: 84532 } as any,
      API_KEY_CONTEXT,
    );

    expect(mockSigningRequestCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        apiKeyId: 'api-key-1',
        authMethod: 'api_key',
        apiKeyPrefix: API_KEY_PREFIX,
        apiKeyName: 'Production key',
        type: 'message',
        chainId: BigInt(84532),
        walletAddress: WALLET.walletAddress,
        digest: hashMessage('Hello, SOFA ONE!'),
        status: 'submitting',
      }),
    });
    expect(mockSigningRequestCreate.mock.calls[0][0].data.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      JSON.stringify(mockSigningRequestCreate.mock.calls[0][0], (_, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toContain('Hello, SOFA ONE!');
    expect(mockSigningRequestUpdate).toHaveBeenCalledWith({
      where: { id: 'signing-request-1' },
      data: { status: 'signed', completedAt: expect.any(Date) },
    });
  });

  it('rejects bearer-token signing before loading the wallet or creating an audit record', async () => {
    await expect(
      service.sign('user-1', { type: 'message', message: 'Hello, SOFA ONE!' } as any),
    ).rejects.toThrow(UnauthorizedException);

    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockVerifyAgentKeyRegistration).not.toHaveBeenCalled();
    expect(mockSigningRequestCreate).not.toHaveBeenCalled();
    expect(mockSignData).not.toHaveBeenCalled();
  });

  it('rejects signing when the agent key is not registered on-chain before creating an audit record', async () => {
    mockVerifyAgentKeyRegistration.mockRejectedValue(
      new BadRequestException('Agent key is not ready'),
    );

    await expect(
      service.sign(
        'user-1',
        { type: 'message', message: 'Hello', chainId: 84532 } as any,
        API_KEY_CONTEXT,
      ),
    ).rejects.toThrow('Agent key is not ready');

    expect(mockSigningRequestCreate).not.toHaveBeenCalled();
    expect(mockSignData).not.toHaveBeenCalled();
  });

  it('marks the signing request failed when Openfort signing fails', async () => {
    mockSignData.mockRejectedValue(new Error('Openfort down'));

    await expect(
      service.sign(
        'user-1',
        { type: 'message', message: 'Hello', chainId: 84532 } as any,
        API_KEY_CONTEXT,
      ),
    ).rejects.toThrow('Openfort down');

    expect(mockSigningRequestUpdate).toHaveBeenCalledWith({
      where: { id: 'signing-request-1' },
      data: { status: 'failed', completedAt: expect.any(Date) },
    });
  });

  it('returns the signature when the post-sign audit update fails', async () => {
    mockSigningRequestUpdate.mockRejectedValue(new Error('DB update failed'));

    const result = await service.sign(
      'user-1',
      { type: 'message', message: 'Hello', chainId: 84532 } as any,
      API_KEY_CONTEXT,
    );

    expect(result).toEqual({
      signature: WRAPPED_SIGNATURE,
      walletAddress: WALLET.walletAddress,
      type: 'message',
      executionMode: 'session_key',
    });
    expect(mockSigningRequestUpdate).toHaveBeenCalledWith({
      where: { id: 'signing-request-1' },
      data: { status: 'signed', completedAt: expect.any(Date) },
    });
  });

  it('preserves the Openfort error when the failed audit update also fails', async () => {
    mockSignData.mockRejectedValue(new Error('Openfort down'));
    mockSigningRequestUpdate.mockRejectedValue(new Error('DB update failed'));

    await expect(
      service.sign(
        'user-1',
        { type: 'message', message: 'Hello', chainId: 84532 } as any,
        API_KEY_CONTEXT,
      ),
    ).rejects.toThrow('Openfort down');
  });

  it('uses EIP-191 hash for raw hex message data', async () => {
    const raw = '0x68656c6c6f20776f726c64';
    const result = await service.sign(
      'user-1',
      { type: 'message', message: { raw }, chainId: 84532 } as any,
      API_KEY_CONTEXT,
    );

    expect(mockSignData).toHaveBeenCalledWith(WALLET.agentOpenfortAccountId, hashMessage({ raw }));
    expect(result).toEqual({
      signature: WRAPPED_SIGNATURE,
      walletAddress: WALLET.walletAddress,
      type: 'message',
      executionMode: 'session_key',
    });
  });

  it('rejects API-key hash signing before creating an audit record', async () => {
    const hash = '0x'.padEnd(66, '1');

    await expect(
      service.sign('user-1', { type: 'hash', hash, chainId: 84532 } as any, API_KEY_CONTEXT),
    ).rejects.toThrow('hash signing is not allowed');

    expect(mockSigningRequestCreate).not.toHaveBeenCalled();
    expect(mockSignData).not.toHaveBeenCalled();
  });

  it('infers chainId from typedData.domain.chainId for API-key typed data signing', async () => {
    const typedData = createTypedData(84532);

    const result = await service.sign(
      'user-1',
      { type: 'typed_data', typedData } as any,
      API_KEY_CONTEXT,
    );

    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      include: {
        chainAuthorizations: { where: { chainId: BigInt(84532) } },
      },
    });
    expect(mockSigningRequestCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'typed_data',
        chainId: BigInt(84532),
      }),
    });
    expect(result).toEqual({
      signature: WRAPPED_SIGNATURE,
      walletAddress: WALLET.walletAddress,
      type: 'typed_data',
      executionMode: 'session_key',
    });
  });

  it('requires typedData.domain.chainId for API-key typed data signing', async () => {
    const typedData = createTypedData(undefined);

    await expect(
      service.sign('user-1', { type: 'typed_data', typedData, chainId: 84532 } as any, {
        id: API_KEY_CONTEXT.id,
        canSign: true,
      }),
    ).rejects.toThrow(
      'typedData.domain.chainId is required when signing typed data with an API key',
    );
  });

  it('requires typedData.domain.chainId to match chainId for API-key typed data signing', async () => {
    const typedData = createTypedData(84531);

    await expect(
      service.sign('user-1', { type: 'typed_data', typedData, chainId: 84532 } as any, {
        id: API_KEY_CONTEXT.id,
        canSign: true,
      }),
    ).rejects.toThrow('typedData.domain.chainId must match chainId');
  });

  it('rejects Permit typed data signing before loading the wallet', async () => {
    const typedData = {
      ...createTypedData(84532),
      primaryType: 'Permit',
      types: {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      message: {
        owner: WALLET.walletAddress,
        spender: '0x1111111111111111111111111111111111111111',
        value: '1',
        nonce: 0,
        deadline: 9999999999,
      },
    };

    await expect(
      service.sign(
        'user-1',
        { type: 'typed_data', typedData, chainId: 84532 } as any,
        API_KEY_CONTEXT,
      ),
    ).rejects.toThrow('Permit typed data signing is not allowed');

    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockSigningRequestCreate).not.toHaveBeenCalled();
    expect(mockSignData).not.toHaveBeenCalled();
  });

  it('allows non-permit typed data signing and records safe typed data metadata', async () => {
    const typedData = createTypedData(84532, '0x1111111111111111111111111111111111111111');

    await service.sign(
      'user-1',
      { type: 'typed_data', typedData, chainId: 84532 } as any,
      API_KEY_CONTEXT,
    );

    expect(mockFindUnique).toHaveBeenCalledTimes(1);
    expect(mockSigningRequestCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'typed_data',
        chainId: BigInt(84532),
        walletAddress: WALLET.walletAddress,
      }),
    });
    expect(mockSigningRequestCreate.mock.calls[0][0].data.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      JSON.stringify(mockSigningRequestCreate.mock.calls[0][0], (_, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toContain('Hello');
  });

  it('rejects invalid typedData.domain.verifyingContract before loading the wallet', async () => {
    const typedData = createTypedData(84532, 'not-an-address');

    await expect(
      service.sign(
        'user-1',
        { type: 'typed_data', typedData, chainId: 84532 } as any,
        API_KEY_CONTEXT,
      ),
    ).rejects.toThrow('typedData.domain.verifyingContract must be a valid address');

    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockSigningRequestCreate).not.toHaveBeenCalled();
    expect(mockSignData).not.toHaveBeenCalled();
  });

  it('includes safe typed data metadata in the audit request hash', async () => {
    const typedData = createTypedData(84532, '0x1111111111111111111111111111111111111111');

    await service.sign(
      'user-1',
      { type: 'typed_data', typedData, chainId: 84532 } as any,
      API_KEY_CONTEXT,
    );

    const expectedDigest = hashTypedData(typedData as any);
    const expectedRequestHash = hashRequest({
      type: 'typed_data',
      chainId: 84532,
      digest: expectedDigest,
      executionMode: 'session_key',
      typedData: {
        typedDataPrimaryType: 'Mail',
        typedDataVerifyingContract: '0x1111111111111111111111111111111111111111',
        typedDataDomainName: 'SOFA ONE',
      },
    });

    expect(mockSigningRequestCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'typed_data',
        chainId: BigInt(84532),
        requestHash: expectedRequestHash,
        digest: expectedDigest,
      }),
    });
    expect(mockSigningRequestCreate.mock.calls[0][0].data.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      JSON.stringify(mockSigningRequestCreate.mock.calls[0][0], (_, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toContain('Hello');
  });

  it('allows API-key typed data signing when explicit chainId matches and is allowed', async () => {
    const typedData = createTypedData(84532);

    const result = await service.sign(
      'user-1',
      { type: 'typed_data', typedData, chainId: 84532 } as any,
      {
        id: API_KEY_CONTEXT.id,
        canSign: true,
      },
    );

    expect(mockSignData).toHaveBeenCalledWith(
      WALLET.agentOpenfortAccountId,
      expect.stringMatching(/^0x[a-f0-9]{64}$/),
    );
    expect(result).toEqual({
      signature: WRAPPED_SIGNATURE,
      walletAddress: WALLET.walletAddress,
      type: 'typed_data',
      executionMode: 'session_key',
    });
  });

  it('throws NotFoundException when wallet not found', async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(
      service.sign(
        'user-1',
        { type: 'message', message: 'Hello', chainId: 84532 } as any,
        API_KEY_CONTEXT,
      ),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('WalletService.getBalances()', () => {
  let service: WalletService;

  const mockFindUnique = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();
    mockFindUnique.mockResolvedValue({ ...WALLET });
    mockGetBalance.mockResolvedValue(BigInt('1000000000000000000'));
    mockReadContract.mockResolvedValue(BigInt('2500000'));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        {
          provide: PrismaService,
          useValue: {
            userWallet: { findUnique: mockFindUnique },
          },
        },
        {
          provide: OpenfortService,
          useValue: {},
        },
        {
          provide: WithdrawalPolicyService,
          useValue: {
            assertWithdrawalAllowed: jest.fn().mockResolvedValue(undefined),
            listWithdrawalAddresses: jest.fn(),
            addWithdrawalAddress: jest.fn(),
            removeWithdrawalAddress: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<WalletService>(WalletService);
  });

  it('returns display balances without raw values or token contracts', async () => {
    const result = await service.getBalances('user-1', 84532);

    expect(result).toEqual({
      chains: [
        expect.objectContaining({
          chainId: 84532,
          balances: [
            { token: expect.any(String), formatted: '1' },
            { token: 'USDC', formatted: '2.5' },
          ],
        }),
      ],
    });
    expect(result).not.toHaveProperty('walletAddress');
    expect(result.chains[0].balances[0]).not.toHaveProperty('raw');
    expect(result.chains[0].balances[1]).not.toHaveProperty('contractAddress');
  });

  it('returns safe fetch-failed balance entries when RPC calls fail', async () => {
    mockGetBalance.mockRejectedValue(new Error('native rpc failure with internal URL'));
    mockReadContract.mockRejectedValue(new Error('usdc rpc failure with raw calldata'));

    const result = await service.getBalances('user-1', 84532);

    expect(result.chains[0].balances).toEqual([
      { token: expect.any(String), formatted: null, error: 'fetch failed' },
      { token: 'USDC', formatted: null, error: 'fetch failed' },
    ]);
    expect(JSON.stringify(result)).not.toContain('internal URL');
    expect(JSON.stringify(result)).not.toContain('raw calldata');
  });

  it('rejects frozen wallets before RPC balance calls', async () => {
    mockFindUnique.mockResolvedValue({
      ...WALLET,
      frozenAt: new Date('2026-05-28T00:00:00.000Z'),
      frozenReason: 'security_review',
    });

    await expect(service.getBalances('user-1', 84532)).rejects.toThrow(ForbiddenException);
    expect(mockGetBalance).not.toHaveBeenCalled();
    expect(mockReadContract).not.toHaveBeenCalled();
  });
});

describe('WalletService.getDepositInfo()', () => {
  let service: WalletService;

  const mockFindUnique = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();
    mockFindUnique.mockResolvedValue({ ...WALLET });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        {
          provide: PrismaService,
          useValue: {
            userWallet: { findUnique: mockFindUnique },
          },
        },
        {
          provide: OpenfortService,
          useValue: {},
        },
        {
          provide: WithdrawalPolicyService,
          useValue: {
            assertWithdrawalAllowed: jest.fn().mockResolvedValue(undefined),
            listWithdrawalAddresses: jest.fn(),
            addWithdrawalAddress: jest.fn(),
            removeWithdrawalAddress: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<WalletService>(WalletService);
  });

  it('returns the requested chain and supported deposit tokens', async () => {
    const supportedChain = getSupportedChain(84532);

    await expect(service.getDepositInfo('user-1', 84532)).resolves.toEqual({
      walletAddress: WALLET.walletAddress,
      chainId: 84532,
      chainName: supportedChain.name,
      status: 'active',
      supportedTokens: ['USDC', supportedChain.nativeCurrencySymbol],
    });
  });

  it('rejects unsupported deposit chains', async () => {
    await expect(service.getDepositInfo('user-1', 999999)).rejects.toThrow(BadRequestException);
  });

  it('rejects frozen wallets before returning deposit info', async () => {
    mockFindUnique.mockResolvedValue({
      ...WALLET,
      frozenAt: new Date('2026-05-28T00:00:00.000Z'),
      frozenReason: 'security_review',
    });

    await expect(service.getDepositInfo('user-1', 84532)).rejects.toThrow(ForbiddenException);
  });
});

function createTypedData(chainId: number | undefined, verifyingContract?: string) {
  return {
    domain: {
      name: 'SOFA ONE',
      version: '1',
      ...(chainId === undefined ? {} : { chainId }),
      ...(verifyingContract === undefined ? {} : { verifyingContract }),
    },
    types: {
      Mail: [{ name: 'message', type: 'string' }],
    },
    primaryType: 'Mail',
    message: { message: 'Hello' },
  };
}
