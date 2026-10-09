import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

// ── viem mock ──────────────────────────────────────────────────────────────────
// Must be declared before any imports that pull in viem transitively.
const mockReadContract = jest.fn();
const mockGetBalance = jest.fn();
const mockRecoverAddress = jest.fn();

jest.mock('viem', () => {
  const actual = jest.requireActual<typeof import('viem')>('viem');
  return {
    ...actual,
    recoverAddress: mockRecoverAddress,
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
import { API_ERROR_CODES } from '../../common/errors/api-error-codes';
import { hashRequest } from '../../common/utils/request-hash';
import type { WithdrawDto } from './dto/withdraw.dto';
import { WithdrawalPolicyService } from './withdrawal-policy.service';
import { EoaExecutionPolicyService } from '../eoa-execution/eoa-execution-policy.service';
import { SigningPolicyService } from './signing-policy.service';
import { SecurityEventService } from '../security-events/security-event.service';
import { RiskEvaluationService } from '../security-events/risk-evaluation.service';
import { SessionKeyPolicyService } from '../session-key/session-key-policy.service';
import { BillingDebtService } from '../billing/billing-debt.service';
import { DefiPolicyService } from '../defi/defi-policy.service';
import { DefiPolicyDenial } from '../defi/defi.types';
import { hashTypedData } from 'viem';
import { POLYMARKET_CLOB_AUTH_ATTESTATION, POLYMARKET_CLOB_AUTH_CAPABILITY_ID } from '../defi/signing/polymarket-clob-auth';
import { DefiCatalogService } from '../defi/defi-catalog.service';
import { buildReviewedManifest } from '../defi/registry/defi-manifest';
import { PolymarketDepositWalletVerifierService } from './polymarket-deposit-wallet-verifier.service';
import { PolymarketSigningBudgetService } from './polymarket-signing-budget.service';

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

const VALID_NATIVE_DTO: WithdrawDto = {
  ...VALID_DTO,
  amount: '100000000000000000', // 0.1 native token in wei
  token: 'NATIVE',
  idempotencyKey: 'native-idem-key-123',
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
// ── test suite ─────────────────────────────────────────────────────────────────

describe('WalletService.withdraw()', () => {
  let service: WalletService;

  // Prisma mock handles
  const mockFindUnique = jest.fn();
  const mockWalletFindMany = jest.fn();
  const mockWalletFindFirst = jest.fn();
  const mockFindFirst = jest.fn();
  /** Interactive-tx findFirst — distinct from root so P2002 recovery can be asserted. */
  const mockTxFindFirst = jest.fn();
  const mockCreate = jest.fn();
  const mockUpdate = jest.fn();
  const mockUpdateMany = jest.fn();
  const mockAssertWithdrawalAllowed = jest.fn();
  const mockAssertDailyLimitWithUserLock = jest.fn();
  const mockTransaction = jest.fn();
  const mockEvaluateRisk = jest.fn();
  const mockEnforceRiskAction = jest.fn();
  const mockGetDebt = jest.fn();

  // Openfort mock handle
  const mockSendUserOperation = jest.fn();
  const mockWaitForUserOperationReceipt = jest.fn();
  let loggerWarnSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    loggerWarnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    // Default: wallet exists, sufficient balance, no duplicate tx, no billing debt
    mockFindUnique.mockResolvedValue({ ...WALLET });
    mockWalletFindMany.mockImplementation(async () => {
      const wallet = await mockFindUnique();
      return wallet ? [wallet] : [];
    });
    mockWalletFindFirst.mockImplementation(async () => mockFindUnique());
    mockFindFirst.mockResolvedValue(null);
    mockTxFindFirst.mockResolvedValue(null);
    mockReadContract.mockResolvedValue(SUFFICIENT_BALANCE);
    mockGetBalance.mockResolvedValue(BigInt('200000000000000000'));
    mockSendUserOperation.mockResolvedValue({ userOpHash: '0xuserop' });
    mockWaitForUserOperationReceipt.mockResolvedValue({ success: true, transactionHash: '0xhash' });
    mockCreate.mockResolvedValue({ id: 'tx-1', txHash: null, status: 'submitting' });
    mockUpdate.mockResolvedValue({ id: 'tx-1', txHash: '0xhash', status: 'pending' });
    mockAssertWithdrawalAllowed.mockResolvedValue(undefined);
    mockAssertDailyLimitWithUserLock.mockResolvedValue(undefined);
    mockGetDebt.mockResolvedValue({ hasDebt: false, invoiceIds: [] });
    mockUpdateMany.mockImplementation(async ({ data }: any) => {
      mockUpdate({ where: { id: 'tx-1' }, data });
      return { count: 1 };
    });
    mockTransaction.mockImplementation(async (callback) =>
      callback({
        transaction: {
          findFirst: mockTxFindFirst,
          create: mockCreate,
          update: mockUpdate,
          updateMany: mockUpdateMany,
        },
      }),
    );
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
            userWallet: { findUnique: mockFindUnique, findMany: mockWalletFindMany, findFirst: mockWalletFindFirst },
            transaction: {
              findFirst: mockFindFirst,
              create: mockCreate,
              update: mockUpdate,
              updateMany: mockUpdateMany,
            },
            $transaction: mockTransaction,
          },
        },
        {
          provide: OpenfortService,
          useValue: {
            submitUserOperation: mockSendUserOperation,
            waitForUserOperationReceipt: mockWaitForUserOperationReceipt,
            sendUserOperation: mockSendUserOperation,
            signData: jest.fn(),
          },
        },
        {
          provide: WithdrawalPolicyService,
          useValue: {
            assertWithdrawalAllowed: mockAssertWithdrawalAllowed,
            assertDailyLimitWithUserLock: mockAssertDailyLimitWithUserLock,
            acquireUserDestinationLock: jest.fn().mockResolvedValue(undefined),
            assertDestinationAllowedInTx: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: BillingDebtService,
          useValue: { getDebt: mockGetDebt },
        },
        { provide: DefiPolicyService, useValue: { authorizeSigning: jest.fn().mockImplementation(() => { throw new ForbiddenException({ code: 'DEFI_FUNCTION_NOT_ALLOWED' }); }), recordDenied: jest.fn() } },
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
    mockWalletFindMany.mockResolvedValue([]);

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
      walletAddress: WALLET.walletAddress,
      requestHash: hashRequest({ operationType: 'withdraw', walletId: WALLET.id, chainId: VALID_DTO.chainId, to: VALID_DTO.to, amount: VALID_DTO.amount, token: VALID_DTO.token, contractAddress: getSupportedChain(VALID_DTO.chainId).usdcAddress }),
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
    mockFindFirst.mockResolvedValue({ id: 'tx-existing', txHash: null, status: 'submitting', walletAddress: WALLET.walletAddress, requestHash: hashRequest({ operationType: 'withdraw', walletId: WALLET.id, chainId: VALID_DTO.chainId, to: VALID_DTO.to, amount: VALID_DTO.amount, token: VALID_DTO.token, contractAddress: getSupportedChain(VALID_DTO.chainId).usdcAddress }) });

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

  it('returns the existing withdrawal after a concurrent idempotency insert race via root prisma', async () => {
    // Outer root miss → inner tx miss → P2002 aborts interactive tx → root re-read hits existing.
    mockFindFirst
      .mockResolvedValueOnce(null)
       .mockResolvedValueOnce({ id: 'tx-existing', txHash: null, status: 'submitting', walletAddress: WALLET.walletAddress, requestHash: hashRequest({ operationType: 'withdraw', walletId: WALLET.id, chainId: VALID_DTO.chainId, to: VALID_DTO.to, amount: VALID_DTO.amount, token: VALID_DTO.token, contractAddress: getSupportedChain(VALID_DTO.chainId).usdcAddress }) });
    mockTxFindFirst.mockResolvedValue(null);
    mockCreate.mockRejectedValue({ code: 'P2002' });

    const result = await service.withdraw('user-1', VALID_DTO);

    expect(result).toEqual({
      transactionId: 'tx-existing',
      transactionHash: null,
      status: 'submitting',
    });
    expect(mockReadContract).toHaveBeenCalledTimes(1);
    expect(mockGetDebt).toHaveBeenCalled();
    expect(mockTxFindFirst).toHaveBeenCalledTimes(1);
    // Recovery must use root prisma findFirst (2 calls: outer + post-P2002), not txClient.
    expect(mockFindFirst).toHaveBeenCalledTimes(2);
    expect(mockSendUserOperation).not.toHaveBeenCalled();
  });

  it('rejects P2002 recovery when the concurrent row has a different requestHash', async () => {
    mockFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'tx-existing',
      txHash: null,
      status: 'submitting',
      walletAddress: WALLET.walletAddress,
      requestHash: 'different-request',
    });
    mockTxFindFirst.mockResolvedValue(null);
    mockCreate.mockRejectedValue({ code: 'P2002' });

    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toThrow(BadRequestException);
    expect(mockFindFirst).toHaveBeenCalledTimes(2);
    expect(mockSendUserOperation).not.toHaveBeenCalled();
  });

  it('rethrows P2002 when no existing withdrawal is found after rollback', async () => {
    mockFindFirst.mockResolvedValue(null);
    mockTxFindFirst.mockResolvedValue(null);
    mockCreate.mockRejectedValue({ code: 'P2002' });

    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toMatchObject({ code: 'P2002' });
    expect(mockFindFirst).toHaveBeenCalledTimes(2);
    expect(mockSendUserOperation).not.toHaveBeenCalled();
  });

  it('rejects withdrawal idempotency reuse with a different request before balance checks', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'tx-existing',
      txHash: '0xhash-existing',
      status: 'pending',
      walletAddress: WALLET.walletAddress,
      requestHash: 'different-request',
    });

    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toThrow(BadRequestException);

    expect(mockReadContract).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSendUserOperation).not.toHaveBeenCalled();
  });

  it('reuses a pre-wallet-bound null-hash row only with matching legacy fingerprint evidence', async () => {
    const chain = getSupportedChain(VALID_DTO.chainId);
    const legacyFingerprint = hashRequest({ operationType: 'withdraw', chainId: VALID_DTO.chainId, to: VALID_DTO.to, amount: VALID_DTO.amount, token: VALID_DTO.token, contractAddress: chain.usdcAddress });
    mockFindFirst.mockResolvedValue({ id: 'legacy-tx', txHash: null, status: 'submitting', walletAddress: WALLET.walletAddress, requestHash: null, details: { requestHash: legacyFingerprint } });
    await expect(service.withdraw('user-1', VALID_DTO)).resolves.toMatchObject({ transactionId: 'legacy-tx' });
    expect(mockReadContract).not.toHaveBeenCalled();
    expect(mockSendUserOperation).not.toHaveBeenCalled();
  });

  it('reuses a matching pre-upgrade non-null legacy fingerprint for the same wallet without resubmitting', async () => {
    const chain = getSupportedChain(VALID_DTO.chainId);
    const legacyFingerprint = hashRequest({ operationType: 'withdraw', chainId: VALID_DTO.chainId, to: VALID_DTO.to, amount: VALID_DTO.amount, token: VALID_DTO.token, contractAddress: chain.usdcAddress });
    mockFindFirst.mockResolvedValue({ id: 'legacy-hash-tx', txHash: '0xlegacy', status: 'pending', walletAddress: WALLET.walletAddress, requestHash: legacyFingerprint });
    await expect(service.withdraw('user-1', VALID_DTO)).resolves.toMatchObject({ transactionId: 'legacy-hash-tx' });
    expect(mockReadContract).not.toHaveBeenCalled();
    expect(mockSendUserOperation).not.toHaveBeenCalled();
  });

  it('rejects a different request against a pre-upgrade fingerprint', async () => {
    const legacyFingerprint = hashRequest({ operationType: 'withdraw', chainId: VALID_DTO.chainId, to: VALID_DTO.to, amount: '999', token: VALID_DTO.token, contractAddress: getSupportedChain(VALID_DTO.chainId).usdcAddress });
    mockFindFirst.mockResolvedValue({ id: 'legacy-hash-tx', txHash: null, status: 'pending', walletAddress: WALLET.walletAddress, requestHash: legacyFingerprint });
    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toThrow(BadRequestException);
    expect(mockSendUserOperation).not.toHaveBeenCalled();
  });

  it('rejects null-hash legacy rows without matching fingerprint proof', async () => {
    mockFindFirst.mockResolvedValue({ id: 'legacy-tx', txHash: null, status: 'submitting', walletAddress: WALLET.walletAddress, requestHash: null, details: {} });
    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toThrow(BadRequestException);
    expect(mockSendUserOperation).not.toHaveBeenCalled();
  });

  it('never reuses an idempotency row belonging to another wallet', async () => {
    mockFindFirst.mockResolvedValue({ id: 'other-wallet-tx', txHash: null, status: 'submitting', walletAddress: '0x9999999999999999999999999999999999999999', requestHash: null, details: {} });
    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toThrow(BadRequestException);
    expect(mockReadContract).not.toHaveBeenCalled();
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
      { skipDailyLimit: true },
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

  it('withdraws native token with a value transfer interaction', async () => {
    const result = await service.withdraw('user-1', VALID_NATIVE_DTO);

    expect(mockGetBalance).toHaveBeenCalledWith({ address: WALLET.walletAddress });
    expect(mockReadContract).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          details: expect.objectContaining({
            token: 'NATIVE',
            contractAddress: null,
          }),
        }),
      }),
    );
    expect(mockSendUserOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        interactions: [
          {
            to: VALID_NATIVE_DTO.to,
            data: '0x',
            value: VALID_NATIVE_DTO.amount,
          },
        ],
      }),
    );
    expect(result).toEqual({
      transactionId: 'tx-1',
      transactionHash: '0xhash',
      status: 'pending',
    });
  });

  it('rejects native withdrawals when native balance is insufficient', async () => {
    mockGetBalance.mockResolvedValue(BigInt('99999999999999999'));

    await expect(service.withdraw('user-1', VALID_NATIVE_DTO)).rejects.toThrow(
      /Insufficient ETH balance/i,
    );
    expect(mockReadContract).not.toHaveBeenCalled();
    expect(mockSendUserOperation).not.toHaveBeenCalled();
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

  it('persists typed UserOperation success and safe compatibility details', async () => {
    await service.withdraw('user-1', VALID_DTO);

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userOpSuccess: true,
          details: expect.objectContaining({ userOperationSuccess: true }),
        }),
      }),
    );
  });

  it('persists typed UserOperation failure without marking it billable', async () => {
    mockWaitForUserOperationReceipt.mockResolvedValue({
      success: false,
      transactionHash: '0xbundle',
    });

    await service.withdraw('user-1', VALID_DTO);

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userOpSuccess: false,
          details: expect.objectContaining({ userOperationSuccess: false }),
        }),
      }),
    );
    const completionWrite = mockUpdateMany.mock.calls.find(
      (call: any[]) => call[0].data.userOpSuccess === false,
    );
    expect(completionWrite?.[0].where).toEqual(
      expect.objectContaining({
        userOpSuccess: null,
        billingReconciledAt: null,
      }),
    );
  });

  it('marks the pre-created withdrawal failed when Openfort submission fails', async () => {
    mockSendUserOperation.mockRejectedValue(new Error('Openfort down'));

    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toThrow('Openfort down');
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'unknown' }),
      }),
    );
  });

  // ── Billing debt gate ──────────────────────────────────────────────────────

  it('blocks new withdrawals when billing debt exists before balance/create/Openfort', async () => {
    mockGetDebt.mockResolvedValue({ hasDebt: true, invoiceIds: ['inv-1'] });

    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toMatchObject({
      response: {
        code: API_ERROR_CODES.BILLING_OUTBOUND_BLOCKED,
      },
    });

    expect(mockGetDebt).toHaveBeenCalledWith('user-1', expect.anything());
    expect(mockReadContract).not.toHaveBeenCalled();
    expect(mockGetBalance).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSendUserOperation).not.toHaveBeenCalled();
    expect(mockAssertDailyLimitWithUserLock).not.toHaveBeenCalled();
  });

  it('returns existing idempotent withdrawal without checking billing debt', async () => {
    const contractAddress = getSupportedChain(VALID_DTO.chainId).usdcAddress;
    mockFindFirst.mockResolvedValue({
      id: 'tx-existing',
      txHash: '0xhash-existing',
      status: 'pending',
      walletAddress: WALLET.walletAddress,
      requestHash: hashRequest({ operationType: 'withdraw', walletId: WALLET.id, chainId: VALID_DTO.chainId, to: VALID_DTO.to, amount: VALID_DTO.amount, token: VALID_DTO.token, contractAddress }),
    });
    mockGetDebt.mockResolvedValue({ hasDebt: true, invoiceIds: ['inv-1'] });

    const result = await service.withdraw('user-1', VALID_DTO);

    expect(result).toEqual({
      transactionId: 'tx-existing',
      transactionHash: '0xhash-existing',
      status: 'pending',
    });
    expect(mockGetDebt).not.toHaveBeenCalled();
    expect(mockReadContract).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSendUserOperation).not.toHaveBeenCalled();
  });

  it('re-checks billing debt inside the create transaction after idempotency miss', async () => {
    mockGetDebt
      .mockResolvedValueOnce({ hasDebt: false, invoiceIds: [] })
      .mockResolvedValueOnce({ hasDebt: true, invoiceIds: ['inv-race'] });

    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toMatchObject({
      response: {
        code: API_ERROR_CODES.BILLING_OUTBOUND_BLOCKED,
      },
    });

    expect(mockGetDebt).toHaveBeenCalledTimes(2);
    expect(mockReadContract).toHaveBeenCalledTimes(1);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockAssertDailyLimitWithUserLock).not.toHaveBeenCalled();
    expect(mockSendUserOperation).not.toHaveBeenCalled();
  });

  it('returns 503 when billing debt check fails (fail-closed)', async () => {
    mockGetDebt.mockRejectedValue(new Error('db unavailable'));

    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toMatchObject({
      response: {
        code: API_ERROR_CODES.BILLING_DEBT_CHECK_UNAVAILABLE,
      },
    });
    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(mockReadContract).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSendUserOperation).not.toHaveBeenCalled();
  });
});

describe('WalletService.sign()', () => {
  let service: WalletService;

  const mockFindUnique = jest.fn();
  const mockWalletFindMany = jest.fn();
  const mockWalletFindFirst = jest.fn();
  const mockSignData = jest.fn();
  const mockVerifyAgentKeyRegistration = jest.fn();
  const mockAssertSessionKeyAllowed = jest.fn();
  const mockSigningRequestCreate = jest.fn();
  const mockSigningRequestUpdate = jest.fn();
  const mockSigningRequestFindMany = jest.fn();
  const mockSigningRequestCount = jest.fn();
  const mockSigningRequestFindFirst = jest.fn();
  const mockAssertEoaExecutionAllowed = jest.fn();
  const mockWithdrawalPolicyFindUnique = jest.fn();
  const mockTxWithdrawalPolicyFindUnique = jest.fn();
  const mockTransaction = jest.fn();
  const mockAcquireUserDestinationLock = jest.fn();
  const mockSecurityEventRecord = jest.fn();
  const mockDefiAuthorizeSigning = jest.fn();
  const mockDefiRecordDenied = jest.fn();
  const mockDefiAssertSigningStillAuthorized = jest.fn();
  const mockDefiRecordSigningAllowed = jest.fn();
  const mockDefiExportSigningAllowed = jest.fn();
  const mockVerifyDepositWallet = jest.fn();
  const mockVerify1271 = jest.fn();
  const mockAssertEvidenceFresh = jest.fn();
  const mockBudgetAcquire = jest.fn();
  const mockBudgetAccept = jest.fn();
  const mockBudgetExport = jest.fn();
  let loggerErrorSpy: jest.SpyInstance;
  let loggerWarnSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    loggerErrorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    loggerWarnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    mockFindUnique.mockResolvedValue({ ...WALLET });
    mockWalletFindMany.mockImplementation(async () => {
      const wallet = await mockFindUnique();
      return wallet ? [wallet] : [];
    });
    mockWalletFindFirst.mockImplementation(async () => mockFindUnique());
    mockVerifyAgentKeyRegistration.mockResolvedValue(undefined);
    mockAssertSessionKeyAllowed.mockResolvedValue(undefined);
    mockSignData.mockResolvedValue(RAW_SIGNATURE);
    mockSigningRequestCreate.mockResolvedValue({ id: 'signing-request-1' });
    mockSigningRequestUpdate.mockResolvedValue({ id: 'signing-request-1', status: 'signed' });
    mockSigningRequestFindMany.mockResolvedValue([]);
    mockSigningRequestCount.mockResolvedValue(0);
    mockSigningRequestFindFirst.mockResolvedValue(null);
    mockAssertEoaExecutionAllowed.mockResolvedValue(undefined);
    // BILL-016 default: destination protection OFF (legacy SigningPolicy path).
    mockWithdrawalPolicyFindUnique.mockResolvedValue(null);
    mockTxWithdrawalPolicyFindUnique.mockResolvedValue(null);
    mockAcquireUserDestinationLock.mockResolvedValue(undefined);
    mockSecurityEventRecord.mockResolvedValue({});
    mockDefiAuthorizeSigning.mockImplementation(() => {
      throw new DefiPolicyDenial(new ForbiddenException({ code: 'DEFI_FUNCTION_NOT_ALLOWED' }), { code: 'DEFI_FUNCTION_NOT_ALLOWED' });
    });
    mockDefiRecordDenied.mockResolvedValue(undefined);
    mockDefiAssertSigningStillAuthorized.mockResolvedValue(undefined);
    mockDefiRecordSigningAllowed.mockResolvedValue({ id: 'allowed-event' });
    mockDefiExportSigningAllowed.mockResolvedValue(undefined);
    mockVerifyDepositWallet.mockResolvedValue({ agent: WALLET.agentWalletAddress.toLowerCase(), deposit: WALLET.walletAddress.toLowerCase(), codeHash: `0x${'1'.repeat(64)}`, checkedAt: Date.now(), rpcFingerprint: `0x${'2'.repeat(64)}` });
    mockVerify1271.mockResolvedValue(undefined);
    mockAssertEvidenceFresh.mockImplementation(() => undefined);
    mockBudgetAcquire.mockResolvedValue(undefined);
    mockBudgetAccept.mockResolvedValue({ id: 'order-accepted' });
    mockBudgetExport.mockResolvedValue(undefined);
    mockTransaction.mockImplementation(async (callback) =>
      callback({
        signingRequest: { create: mockSigningRequestCreate },
        withdrawalPolicy: { findUnique: mockTxWithdrawalPolicyFindUnique },
        $queryRaw: jest.fn(),
        defiPolicyState: { findUnique: jest.fn() },
        apiKey: { findUnique: jest.fn() },
        userWallet: { findFirst: jest.fn() },
        user: { findUnique: jest.fn() },
      }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        {
          provide: PrismaService,
          useValue: {
            userWallet: { findMany: mockWalletFindMany, findFirst: mockWalletFindFirst },
            signingRequest: { create: mockSigningRequestCreate, update: mockSigningRequestUpdate, findMany: mockSigningRequestFindMany, count: mockSigningRequestCount, findFirst: mockSigningRequestFindFirst },
            withdrawalPolicy: { findUnique: mockWithdrawalPolicyFindUnique },
            $transaction: mockTransaction,
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
          useValue: { assertAllowed: mockAssertEoaExecutionAllowed, assertPolymarketOrderPrerequisites: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: SessionKeyPolicyService,
          useValue: { assertSessionKeyAllowed: mockAssertSessionKeyAllowed },
        },
        {
          provide: SecurityEventService,
          useValue: { record: mockSecurityEventRecord },
        },
        {
          provide: WithdrawalPolicyService,
          useValue: {
            assertWithdrawalAllowed: jest.fn().mockResolvedValue(undefined),
            listWithdrawalAddresses: jest.fn(),
            addWithdrawalAddress: jest.fn(),
            removeWithdrawalAddress: jest.fn(),
            acquireUserDestinationLock: mockAcquireUserDestinationLock,
          },
        },
        {
          provide: BillingDebtService,
          useValue: { getDebt: jest.fn().mockResolvedValue({ hasDebt: false, invoiceIds: [] }) },
        },
        { provide: DefiPolicyService, useValue: { authorizeSigning: mockDefiAuthorizeSigning, recordDenied: mockDefiRecordDenied, assertSigningStillAuthorized: mockDefiAssertSigningStillAuthorized, recordSigningAllowedInTx: mockDefiRecordSigningAllowed, exportSigningAllowed: mockDefiExportSigningAllowed } },
        { provide: PolymarketDepositWalletVerifierService, useValue: { verify: mockVerifyDepositWallet, assertFresh: mockAssertEvidenceFresh, verify1271: mockVerify1271 } },
        { provide: PolymarketSigningBudgetService, useValue: { acquireWalletLock: mockBudgetAcquire, recordAcceptedInTransaction: mockBudgetAccept, exportAccepted: mockBudgetExport } },
        SigningPolicyService,
      ],
    }).compile();

    service = module.get<WalletService>(WalletService);
  });

  it('scopes selected-wallet history to both embedded and agent addresses', async () => {
    const second = { ...WALLET, id: 'wallet-2', walletAddress: '0x4444444444444444444444444444444444444444', agentWalletAddress: '0x5555555555555555555555555555555555555555' };
    mockWalletFindMany.mockResolvedValue([WALLET, second]);
    mockSigningRequestFindMany.mockResolvedValue([]);
    await service.listSigningRequests('user-1', { walletId: second.id } as any);
    expect(mockSigningRequestFindMany.mock.calls.at(-1)?.[0].where.walletAddress).toEqual({ in: [second.walletAddress, second.agentWalletAddress] });
  });

  it('returns empty pending-wallet history and not-found detail without Prisma null-address lookup', async () => {
    const pending = { ...WALLET, id: 'pending-wallet', walletAddress: null, agentWalletAddress: null };
    mockWalletFindMany.mockResolvedValue([pending]);
    await expect(service.listSigningRequests('user-1', { walletId: pending.id } as any)).resolves.toMatchObject({ items: [], total: 0 });
    expect(mockSigningRequestFindMany).not.toHaveBeenCalled();
    await expect(service.getSigningRequestDetail('user-1', 'sr-1', pending.id)).rejects.toThrow(NotFoundException);
    expect(mockSigningRequestFindFirst).not.toHaveBeenCalled();
  });

  afterEach(() => {
    loggerErrorSpy.mockRestore();
    loggerWarnSpy.mockRestore();
  });

  it('conflicts when walletId is omitted and multiple active owner wallets exist', async () => {
    mockWalletFindMany.mockResolvedValue([
      { ...WALLET },
      { ...WALLET, id: 'wallet-2', walletAddress: '0x4444444444444444444444444444444444444444' },
    ]);
    await expect(service.sign('user-1', { type: 'typed_data', typedData: createTypedData(137), chainId: 137 } as any, API_KEY_CONTEXT))
      .rejects.toBeInstanceOf(ConflictException);
    expect(mockWalletFindMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(mockSignData).not.toHaveBeenCalled();
  });

  it('rejects a forged wallet ID not present in the authenticated owner wallet set', async () => {
    mockWalletFindMany.mockResolvedValue([{ ...WALLET }]);
    await expect(service.sign('user-1', {
      type: 'typed_data', typedData: createTypedData(137), chainId: 137, walletId: 'wallet-for-another-user',
    } as any, API_KEY_CONTEXT)).rejects.toThrow(NotFoundException);
    expect(mockWalletFindMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(mockSignData).not.toHaveBeenCalled();
  });

  it.each([
    ['message', { type: 'message', message: 'Hello', chainId: 84532 }],
    ['typed_data', { type: 'typed_data', chainId: 84532, typedData: { domain: { chainId: 84532 }, types: {}, primaryType: 'Mail', message: {} } }],
  ])('denies %s signing before success audit, hash persistence, or Openfort', async (_name, dto) => {
    await expect(service.sign('user-1', dto as any, API_KEY_CONTEXT)).rejects.toThrow(ForbiddenException);
    const typed = (dto as any).type === 'typed_data';
    expect(mockDefiAuthorizeSigning).toHaveBeenCalledTimes(typed ? 1 : 0);
    expect(mockDefiRecordDenied).toHaveBeenCalledTimes(typed ? 1 : 0);
    expect(mockSigningRequestCreate).not.toHaveBeenCalled();
    expect(mockSignData).not.toHaveBeenCalled();
    expect(mockSecurityEventRecord).not.toHaveBeenCalled();
  });

  it('accepts only the bound EOA ClobAuth payload and signs/persists the same digest', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const payload = Object.freeze({ domain: Object.freeze({ name: 'ClobAuthDomain', version: '1', chainId: 137 }), types: Object.freeze({ ClobAuth: Object.freeze([{ name: 'address', type: 'address' }, { name: 'timestamp', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'message', type: 'string' }]) }), primaryType: 'ClobAuth', message: Object.freeze({ address: WALLET.agentWalletAddress, timestamp, nonce: '0', message: POLYMARKET_CLOB_AUTH_ATTESTATION }) });
    const digest = hashTypedData(payload as any);
    mockDefiAuthorizeSigning.mockResolvedValue(Object.freeze({ context: Object.freeze({ userId: 'user-1', apiKeyId: 'api-key-1', walletId: 'wallet-1', chainId: 137, executionMode: 'eoa', executionOwner: WALLET.agentWalletAddress, allowedCapabilityIds: [POLYMARKET_CLOB_AUTH_CAPABILITY_ID] }), requiredPermission: 'canSign', capabilityId: POLYMARKET_CLOB_AUTH_CAPABILITY_ID, chainId: 137, executionMode: 'eoa', policyHash: `0x${'1'.repeat(64)}`, typedDataDigest: digest, payload, bindingCommitment: `0x${'2'.repeat(64)}`, walletAddress: WALLET.walletAddress.toLowerCase(), agentWalletAddress: WALLET.agentWalletAddress.toLowerCase(), agentOpenfortAccountId: WALLET.agentOpenfortAccountId }));
    const result = await service.sign('user-1', { type: 'typed_data', chainId: 137, executionMode: 'eoa', typedData: payload } as any, { ...API_KEY_CONTEXT, canUseEoaExecution: true });
    expect(mockDefiAssertSigningStillAuthorized).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ typedDataDigest: digest }), expect.objectContaining({ digest, agentOpenfortAccountId: WALLET.agentOpenfortAccountId }));
    expect(mockSigningRequestCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ digest }) }));
    expect(mockSignData).toHaveBeenCalledWith(WALLET.agentOpenfortAccountId, digest);
    expect(result).toMatchObject({ signature: RAW_SIGNATURE, agentWalletAddress: WALLET.agentWalletAddress, executionMode: 'eoa' });
    expect(mockDefiRecordSigningAllowed).toHaveBeenCalledTimes(1);
    expect(mockDefiExportSigningAllowed).toHaveBeenCalledWith({ id: 'allowed-event' });
  });

  it('sanitizes an order-provider error containing signature/envelope material before HTTP propagation or logging', async () => {
    const maker = WALLET.walletAddress.toLowerCase();
    const types = {
      Order: [{ name:'salt',type:'uint256' },{ name:'maker',type:'address' },{ name:'signer',type:'address' },{ name:'tokenId',type:'uint256' },{ name:'makerAmount',type:'uint256' },{ name:'takerAmount',type:'uint256' },{ name:'side',type:'uint8' },{ name:'signatureType',type:'uint8' },{ name:'timestamp',type:'uint256' },{ name:'metadata',type:'bytes32' },{ name:'builder',type:'bytes32' }],
      TypedDataSign: [{ name:'contents',type:'Order' },{ name:'name',type:'string' },{ name:'version',type:'string' },{ name:'chainId',type:'uint256' },{ name:'verifyingContract',type:'address' },{ name:'salt',type:'bytes32' }],
    };
    const order = { salt:'1', maker, signer:maker, tokenId:'2', makerAmount:'3', takerAmount:'4', side:0, signatureType:3, timestamp:String(Date.now()), metadata:`0x${'00'.repeat(32)}`, builder:`0x${'00'.repeat(32)}` };
    const typedData = { domain:{ name:'Polymarket CTF Exchange', version:'2', chainId:137, verifyingContract:'0xE111180000d2663C0091e4f400237545B87B996B' }, types, primaryType:'TypedDataSign', message:{ contents:order, name:'DepositWallet', version:'1', chainId:137, verifyingContract:maker, salt:`0x${'00'.repeat(32)}` } };
    const digest = hashTypedData(typedData as any);
    mockDefiAuthorizeSigning.mockResolvedValue({ context:{ userId:'user-1', apiKeyId:'api-key-1', walletId:'wallet-1', chainId:137, executionMode:'eoa', executionOwner:WALLET.agentWalletAddress, capabilityMode:'custom', allowedCapabilityIds:['polymarket:137:clob-order:v2'] }, requiredPermission:'canSign', capabilityId:'polymarket:137:clob-order:v2', chainId:137, executionMode:'eoa', typedDataDigest:digest, payload:typedData, walletAddress:maker.toLowerCase(), agentWalletAddress:WALLET.agentWalletAddress.toLowerCase(), agentOpenfortAccountId:WALLET.agentOpenfortAccountId });
    const sentinel = 'SENTINEL_SECRET_RAW_SIGNATURE_OR_ENVELOPE';
    mockSignData.mockRejectedValueOnce(new Error(`provider failed ${sentinel}`));
    let thrown: any;
    try { await service.sign('user-1', { type:'typed_data', chainId:137, executionMode:'eoa', typedData } as any, { ...API_KEY_CONTEXT, capabilityMode:'custom', allowedCapabilityIds:['polymarket:137:clob-order:v2'], canUseEoaExecution:true }); }
    catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ status:503, response:{ code:'POLYMARKET_SIGNING_FAILED', message:'Polymarket order signing could not be verified' } });
    expect(JSON.stringify(thrown.getResponse())).not.toContain(sentinel);
    expect(JSON.stringify(loggerErrorSpy.mock.calls)).not.toContain(sentinel);
    expect(mockSigningRequestUpdate).toHaveBeenCalledWith(expect.objectContaining({ data:expect.objectContaining({ status:'failed' }) }));
    expect(mockAssertEvidenceFresh.mock.invocationCallOrder[0]).toBeGreaterThan(mockBudgetAcquire.mock.invocationCallOrder[0]);
    expect(mockAssertEvidenceFresh.mock.invocationCallOrder[0]).toBeLessThan(mockDefiAssertSigningStillAuthorized.mock.invocationCallOrder.at(-1)!);

    mockSignData.mockClear(); mockSigningRequestCreate.mockClear(); mockBudgetAccept.mockClear();
    mockAssertEvidenceFresh.mockImplementationOnce(() => { throw new ServiceUnavailableException('expired'); });
    await expect(service.sign('user-1', { type:'typed_data', chainId:137, executionMode:'eoa', typedData } as any, { ...API_KEY_CONTEXT, capabilityMode:'custom', allowedCapabilityIds:['polymarket:137:clob-order:v2'], canUseEoaExecution:true })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(mockBudgetAccept).not.toHaveBeenCalled();
    expect(mockSigningRequestCreate).not.toHaveBeenCalled();
    expect(mockSignData).not.toHaveBeenCalled();

    mockVerifyDepositWallet.mockResolvedValueOnce({ agent:WALLET.agentWalletAddress.toLowerCase(), deposit:maker, codeHash:`0x${'1'.repeat(64)}`, checkedAt:Date.now(), rpcFingerprint:`0x${'2'.repeat(64)}` })
      .mockResolvedValueOnce({ agent:WALLET.agentWalletAddress.toLowerCase(), deposit:maker, codeHash:`0x${'3'.repeat(64)}`, checkedAt:Date.now(), rpcFingerprint:`0x${'2'.repeat(64)}` });
    mockRecoverAddress.mockResolvedValue(WALLET.agentWalletAddress);
    mockSignData.mockResolvedValueOnce(RAW_SIGNATURE);
    mockSigningRequestCreate.mockResolvedValue({ id:'signing-request-code-change' });
    await expect(service.sign('user-1', { type:'typed_data', chainId:137, executionMode:'eoa', typedData } as any, { ...API_KEY_CONTEXT, capabilityMode:'custom', allowedCapabilityIds:['polymarket:137:clob-order:v2'], canUseEoaExecution:true })).rejects.toMatchObject({ response:{ code:'POLYMARKET_SIGNING_FAILED' } });
    expect(mockVerify1271).not.toHaveBeenCalled();
    expect(mockSigningRequestUpdate).toHaveBeenCalledWith(expect.objectContaining({ where:{ id:'signing-request-code-change' }, data:expect.objectContaining({ status:'failed' }) }));
  });

  it('wires real signing authorization through wallet acceptance and denies changed live key/pause state before persistence/provider', async () => {
    const prisma = (service as any).prisma;
    let pauseKeys: string[] = [];
    const rootPauseKeysObserved: string[][] = [];
    prisma.defiPolicyState = { findUnique: jest.fn().mockImplementation(async () => { rootPauseKeysObserved.push([...pauseKeys]); return { id: 'global', pausedScopeKeys: pauseKeys }; }) };
    const catalog = new DefiCatalogService([], prisma, buildReviewedManifest());
    const realPolicy = new DefiPolicyService(prisma, { record: mockSecurityEventRecord, exportCommitted: mockDefiExportSigningAllowed } as any, catalog);
    const preflightSpy = jest.spyOn(realPolicy, 'authorizeSigning');
    const finalAcceptanceSpy = jest.spyOn(realPolicy, 'assertSigningStillAuthorized');
    (service as any).defiPolicy = realPolicy;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const typedData = { domain: { name: 'ClobAuthDomain', version: '1', chainId: 137 }, types: { ClobAuth: [{ name: 'address', type: 'address' }, { name: 'timestamp', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'message', type: 'string' }] }, primaryType: 'ClobAuth', message: { address: WALLET.agentWalletAddress, timestamp, nonce: 0, message: POLYMARKET_CLOB_AUTH_ATTESTATION } };
    const acceptedKey = { userId: 'user-1', revoked: false, frozenAt: null, expiresAt: null, canSign: true, canUseEoaExecution: true, capabilityMode: 'all' as const, allowedCapabilityIds: [] as string[] };
    let liveKey: any = acceptedKey;
    let finalPauseKeys: string[] = [];
    let failCommit = false;
    let txOpen = false;
    let finalLockQueries: unknown[][] = [];
    let lockOrder: string[] = [];
    let liveKeyReadCount = 0;
    mockAcquireUserDestinationLock.mockImplementation(async () => { lockOrder.push('destination'); });
    mockSecurityEventRecord.mockImplementation(async (event: any) => {
      if (event.eventType === 'defi.policy_denied') expect(txOpen).toBe(false);
      if (event.eventType === 'defi.signing_capability_allowed') expect(txOpen).toBe(true);
      return { id: `event-${event.eventType}`, eventType: event.eventType };
    });
    mockTransaction.mockImplementation(async (callback) => {
      txOpen = true;
      finalLockQueries = [];
      lockOrder = [];
      liveKeyReadCount = 0;
      try {
      const result = await callback({
        signingRequest: { create: mockSigningRequestCreate }, withdrawalPolicy: { findUnique: mockTxWithdrawalPolicyFindUnique }, $queryRaw: jest.fn((...args: unknown[]) => { finalLockQueries.push(args); const sql = Array.isArray(args[0]) ? args[0].join(' ') : String(args[0]); lockOrder.push(sql.includes('defi_policy_state') ? 'policy-share' : 'key-update'); }),
        defiPolicyState: { findUnique: jest.fn().mockImplementation(async () => ({ id: 'global', pausedScopeKeys: finalPauseKeys })) },
        apiKey: { findUnique: jest.fn().mockImplementation(async () => { liveKeyReadCount++; lockOrder.push('live-key-read'); return liveKey; }) },
        userWallet: { findFirst: jest.fn().mockResolvedValue({ ...WALLET, frozenAt: null }) },
        user: { findUnique: jest.fn().mockResolvedValue({ id: 'user-1', frozenAt: null }) },
      });
      if (failCommit) { failCommit = false; throw new Error('commit failed'); }
      return result;
      } finally { txOpen = false; }
    });
    const key = { ...API_KEY_CONTEXT, canUseEoaExecution: true, capabilityMode: 'all' as const, allowedCapabilityIds: [] as string[] };
    for (const failure of [
      { key: { ...acceptedKey, capabilityMode: 'custom', allowedCapabilityIds: [] }, rootPause: [], finalPause: [] },
      { key: { ...acceptedKey, capabilityMode: 'custom', allowedCapabilityIds: ['another:capability:v1'] }, rootPause: [], finalPause: [] },
      { key: acceptedKey, rootPause: [], finalPause: ['global'] },
      { key: { ...acceptedKey, revoked: true }, rootPause: [], finalPause: [] },
      { key: { ...acceptedKey, canSign: false }, rootPause: [], finalPause: [] },
      { key: { ...acceptedKey, canUseEoaExecution: false }, rootPause: [], finalPause: [] },
    ]) {
      mockSigningRequestCreate.mockClear(); mockSignData.mockClear(); mockSecurityEventRecord.mockClear(); mockDefiExportSigningAllowed.mockClear();
      liveKey = failure.key; pauseKeys = failure.rootPause; finalPauseKeys = failure.finalPause;
      rootPauseKeysObserved.length = 0;
      const signing = service.sign('user-1', { type: 'typed_data', chainId: 137, executionMode: 'eoa', typedData } as any, key);
      if (failure.finalPause.length) {
        await expect(signing).rejects.toMatchObject({ response: { code: 'DEFI_CAPABILITY_PAUSED' } });
        expect(rootPauseKeysObserved).toEqual([[]]);
        expect(finalLockQueries).toHaveLength(2);
      } else await expect(signing).rejects.toThrow();
      expect(finalAcceptanceSpy).toHaveBeenCalled();
      expect(liveKeyReadCount).toBe(1);
      expect(lockOrder).toEqual(['destination', 'policy-share', 'key-update', 'live-key-read']);
      expect(finalLockQueries).toHaveLength(2);
      expect(mockSigningRequestCreate).not.toHaveBeenCalled();
      expect(mockSignData).not.toHaveBeenCalled();
      expect(mockDefiExportSigningAllowed).not.toHaveBeenCalled();
      expect(mockSecurityEventRecord).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'defi.policy_denied', result: 'denied' }));
      const denialEvent = mockSecurityEventRecord.mock.calls.find(([event]) => event.eventType === 'defi.policy_denied')?.[0];
      expect(denialEvent?.metadata).not.toHaveProperty('digest');
      expect(denialEvent?.metadata).not.toHaveProperty('typedData');
    }
    await expect(preflightSpy.mock.results[0].value).resolves.toMatchObject({ capabilityId: POLYMARKET_CLOB_AUTH_CAPABILITY_ID, context: { capabilityMode: 'all', allowedCapabilityIds: [] } });
    pauseKeys = []; finalPauseKeys = []; liveKey = acceptedKey;
    mockSigningRequestCreate.mockClear(); mockSignData.mockClear(); mockDefiExportSigningAllowed.mockClear();
    await expect(service.sign('user-1', { type: 'message', message: 'x', chainId: 137, typedData } as any, key)).rejects.toThrow(ForbiddenException);
    expect(mockDefiAuthorizeSigning).not.toHaveBeenCalled();
    expect(mockSigningRequestCreate).not.toHaveBeenCalled();
    expect(mockSignData).not.toHaveBeenCalled();

    // Destination policy turned on after preflight but before the atomic acceptance check.
    mockTxWithdrawalPolicyFindUnique.mockResolvedValue({ requireAddressAllowlist: true });
    await expect(service.sign('user-1', { type: 'typed_data', chainId: 137, executionMode: 'eoa', typedData } as any, key)).rejects.toThrow(ForbiddenException);
    expect(mockSigningRequestCreate).not.toHaveBeenCalled(); expect(mockSignData).not.toHaveBeenCalled(); expect(mockDefiExportSigningAllowed).not.toHaveBeenCalled();
    mockTxWithdrawalPolicyFindUnique.mockResolvedValue(null);

    // Advance time on the second final-transaction lock (api_keys UPDATE), after the
    // pre-lock authorization-payload validation has already completed.
    let postLockClock: jest.SpyInstance | undefined;
    let queryCount = 0;
    mockTransaction.mockImplementationOnce(async (callback) => {
      txOpen = true;
      finalLockQueries = [];
      try {
        const tx = {
          signingRequest: { create: mockSigningRequestCreate }, withdrawalPolicy: { findUnique: mockTxWithdrawalPolicyFindUnique },
          $queryRaw: jest.fn((...args: unknown[]) => {
            finalLockQueries.push(args);
            queryCount++;
            if (queryCount === 2) postLockClock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 301_000);
          }),
          defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) },
          apiKey: { findUnique: jest.fn().mockResolvedValue(acceptedKey) },
          userWallet: { findFirst: jest.fn().mockResolvedValue({ ...WALLET, frozenAt: null }) },
          user: { findUnique: jest.fn().mockResolvedValue({ id: 'user-1', frozenAt: null }) },
        };
        return await callback(tx);
      } finally { txOpen = false; }
    });
    mockSigningRequestCreate.mockClear(); mockSignData.mockClear(); mockDefiExportSigningAllowed.mockClear();
    await expect(service.sign('user-1', { type: 'typed_data', chainId: 137, executionMode: 'eoa', typedData } as any, key)).rejects.toThrow();
    postLockClock?.mockRestore();
    expect(queryCount).toBe(2);
    expect(finalLockQueries).toHaveLength(2);
    expect(mockSigningRequestCreate).not.toHaveBeenCalled(); expect(mockSignData).not.toHaveBeenCalled(); expect(mockDefiExportSigningAllowed).not.toHaveBeenCalled();

    // Mutating the source DTO after authorization cannot change canonical payload digest.
    const frozenPayload = { ...typedData, message: { ...typedData.message } };
    const expected = hashTypedData(frozenPayload as any);
    mockAcquireUserDestinationLock.mockImplementationOnce(async () => { (typedData.message as any).nonce = 9; });
    await service.sign('user-1', { type: 'typed_data', chainId: 137, executionMode: 'eoa', typedData } as any, key);
    expect(mockSignData).toHaveBeenLastCalledWith(WALLET.agentOpenfortAccountId, expected);
    expect(mockSigningRequestCreate).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ digest: expected }) }));
    mockSignData.mockClear(); mockDefiExportSigningAllowed.mockClear();
    mockSigningRequestCreate.mockRejectedValueOnce(new Error('create failed'));
    await expect(service.sign('user-1', { type: 'typed_data', chainId: 137, executionMode: 'eoa', typedData: frozenPayload } as any, key)).rejects.toThrow('create failed');
    expect(mockSignData).not.toHaveBeenCalled();
    expect(mockDefiExportSigningAllowed).not.toHaveBeenCalled();
    mockSigningRequestCreate.mockResolvedValue({ id: 'signing-request-committed' });
    mockSignData.mockClear(); mockDefiExportSigningAllowed.mockClear(); failCommit = true;
    await expect(service.sign('user-1', { type: 'typed_data', chainId: 137, executionMode: 'eoa', typedData: frozenPayload } as any, key)).rejects.toThrow('commit failed');
    expect(mockSignData).not.toHaveBeenCalled();
    expect(mockDefiExportSigningAllowed).not.toHaveBeenCalled();
  });

  it('preserves stable signing denial if audit recording fails', async () => {
    mockDefiRecordDenied.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(service.sign('user-1', { type: 'typed_data', chainId: 137, executionMode: 'eoa', typedData: createTypedData(137) } as any, { ...API_KEY_CONTEXT, canUseEoaExecution: true }))
      .rejects.toMatchObject({ response: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
    expect(mockSigningRequestCreate).not.toHaveBeenCalled();
    expect(mockSignData).not.toHaveBeenCalled();
  });

  it('keeps raw-hash signing disabled without invoking DeFi signing authorization', async () => {
    await expect(service.sign('user-1', { type: 'hash', hash: `0x${'11'.repeat(32)}`, chainId: 84532 } as any, API_KEY_CONTEXT)).rejects.toThrow();
    expect(mockDefiAuthorizeSigning).not.toHaveBeenCalled();
    expect(mockSigningRequestCreate).not.toHaveBeenCalled();
    expect(mockSignData).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when wallet not found', async () => {
    mockWalletFindMany.mockResolvedValue([]);

    await expect(
      service.sign(
        'user-1',
        { type: 'typed_data', typedData: createTypedData(137), chainId: 137 } as any,
        API_KEY_CONTEXT,
      ),
    ).rejects.toThrow(NotFoundException);
  });

  // ── BILL-016 destination protection on public sign ─────────────────────────

  const expectNoSignSideEffects = () => {
    expect(mockSigningRequestCreate).not.toHaveBeenCalled();
    expect(mockSignData).not.toHaveBeenCalled();
  };

  const expectSigningBlocked = async (promise: Promise<unknown>) => {
    await expect(promise).rejects.toBeInstanceOf(ForbiddenException);
    try {
      await promise;
    } catch (err) {
      expect((err as ForbiddenException).getResponse()).toEqual(
        expect.objectContaining({
          code: API_ERROR_CODES.SIGNING_BLOCKED_BY_DESTINATION_PROTECTION,
          message: expect.stringMatching(/destination protection/i),
        }),
      );
    }
    expectNoSignSideEffects();
  };

  it.each([
    {
      name: 'typed_data × session_key',
      dto: { type: 'typed_data', typedData: createTypedData(137), chainId: 137 },
      apiKey: API_KEY_CONTEXT,
    },
    {
      name: 'typed_data × eoa',
      dto: {
        type: 'typed_data',
        typedData: createTypedData(137),
        chainId: 137,
        executionMode: 'eoa',
      },
      apiKey: { ...API_KEY_CONTEXT, canUseEoaExecution: true },
    },
    {
      name: 'typed_data × session_key',
      dto: { type: 'typed_data', typedData: createTypedData(137), chainId: 137 },
      apiKey: API_KEY_CONTEXT,
    },
    {
      name: 'typed_data × eoa',
      dto: {
        type: 'typed_data',
        typedData: createTypedData(137),
        chainId: 137,
        executionMode: 'eoa',
      },
      apiKey: { ...API_KEY_CONTEXT, canUseEoaExecution: true },
    },
  ])(
    'blocks typed-data signing when requireAddressAllowlist=true ($name)',
    async ({ dto, apiKey }) => {
      mockWithdrawalPolicyFindUnique.mockResolvedValue({ requireAddressAllowlist: true });

      await expectSigningBlocked(service.sign('user-1', dto as any, apiKey));

      expect(mockAcquireUserDestinationLock).not.toHaveBeenCalled();
      expect(mockTransaction).not.toHaveBeenCalled();
      expect(mockAssertSessionKeyAllowed).not.toHaveBeenCalled();
      expect(mockAssertEoaExecutionAllowed).not.toHaveBeenCalled();
      expect(mockSecurityEventRecord).toHaveBeenCalledTimes(1);
      expect(mockSecurityEventRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'api_key',
          eventType: 'signing.policy_denied',
          userId: 'user-1',
          result: 'denied',
          metadata: expect.objectContaining({
            code: API_ERROR_CODES.SIGNING_BLOCKED_BY_DESTINATION_PROTECTION,
            type: dto.type,
            chainId: 137,
            executionMode: (dto as any).executionMode ?? 'session_key',
            apiKeyPrefix: API_KEY_PREFIX,
          }),
        }),
      );
      const auditJson = JSON.stringify(mockSecurityEventRecord.mock.calls[0][0]);
      expect(auditJson).not.toMatch(/Hello|typedData|domain|primaryType|calldata|digest|requestHash|signature/i);
    },
  );

  it('blocks when protection is on even with empty allowlist / no reauth path', async () => {
    mockWithdrawalPolicyFindUnique.mockResolvedValue({ requireAddressAllowlist: true });

    await expectSigningBlocked(
      service.sign(
        'user-1',
        { type: 'typed_data', typedData: createTypedData(137), chainId: 137 } as any,
        API_KEY_CONTEXT,
      ),
    );
    expectNoSignSideEffects();
  });

  it.each([
    { label: 'null policy', policy: null },
    { label: 'requireAddressAllowlist false', policy: { requireAddressAllowlist: false } },
  ])('still denies signing when destination protection is off ($label)', async ({ policy }) => {
    mockWithdrawalPolicyFindUnique.mockResolvedValue(policy);
    mockTxWithdrawalPolicyFindUnique.mockResolvedValue(policy);

    await expect(service.sign(
      'user-1',
      { type: 'typed_data', typedData: createTypedData(137), chainId: 137 } as any,
      API_KEY_CONTEXT,
    )).rejects.toThrow(ForbiddenException);
    expect(mockAcquireUserDestinationLock).not.toHaveBeenCalled();
    expect(mockSigningRequestCreate).not.toHaveBeenCalled();
    expect(mockSignData).not.toHaveBeenCalled();
    expect(mockSecurityEventRecord).not.toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          code: API_ERROR_CODES.SIGNING_BLOCKED_BY_DESTINATION_PROTECTION,
        }),
      }),
    );
  });

  it('returns 503 and no side effects when preflight policy lookup fails', async () => {
    mockWithdrawalPolicyFindUnique.mockRejectedValue(new Error('db down'));

    await expect(
      service.sign(
        'user-1',
        { type: 'typed_data', typedData: createTypedData(137), chainId: 137 } as any,
        API_KEY_CONTEXT,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    try {
      await service.sign(
        'user-1',
        { type: 'typed_data', typedData: createTypedData(137), chainId: 137 } as any,
        API_KEY_CONTEXT,
      );
    } catch (err) {
      expect((err as ServiceUnavailableException).getResponse()).toEqual(
        expect.objectContaining({
          code: API_ERROR_CODES.WITHDRAWAL_DESTINATION_POLICY_UNAVAILABLE,
        }),
      );
    }

    expectNoSignSideEffects();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('still returns 403 when destination-protection audit recording fails', async () => {
    mockWithdrawalPolicyFindUnique.mockResolvedValue({ requireAddressAllowlist: true });
    mockSecurityEventRecord.mockRejectedValue(new Error('audit down'));

    await expectSigningBlocked(
      service.sign(
        'user-1',
        { type: 'typed_data', typedData: createTypedData(137), chainId: 137 } as any,
        API_KEY_CONTEXT,
      ),
    );

    expect(mockSecurityEventRecord).toHaveBeenCalledTimes(1);
    expect(loggerErrorSpy).toHaveBeenCalled();
  });

  it('returns display balances without raw values or token contracts', async () => {
    const result = await service.getBalances('user-1', 8453);

    expect(result.chains[0]).toEqual(expect.objectContaining({ chainId: 8453, chainName: 'Base' }));
    expect(result.chains[0].balances).toEqual([
      { token: 'ETH', formatted: '0.2' },
      { token: 'USDC', formatted: '2' },
      { token: 'USDT', formatted: '2' },
    ]);
    expect(result).not.toHaveProperty('walletAddress');
    expect(result.chains[0].balances[0]).not.toHaveProperty('raw');
    expect(result.chains[0].balances[1]).not.toHaveProperty('contractAddress');
  });

  it('returns safe fetch-failed balance entries when RPC calls fail', async () => {
    mockGetBalance.mockRejectedValue(new Error('native rpc failure with internal URL'));
    mockReadContract.mockRejectedValue(new Error('usdc rpc failure with raw calldata'));

    const result = await service.getBalances('user-1', 8453);

    expect(result.chains[0].balances).toEqual([
      { token: expect.any(String), formatted: null, error: 'fetch failed' },
      { token: 'USDC', formatted: null, error: 'fetch failed' },
      { token: 'USDT', formatted: null, error: 'fetch failed' },
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
            userWallet: { findUnique: mockFindUnique, findMany: jest.fn(async () => { const wallet = await mockFindUnique(); return wallet ? [wallet] : []; }), findFirst: jest.fn(() => mockFindUnique()) },
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
        {
          provide: BillingDebtService,
          useValue: { getDebt: jest.fn().mockResolvedValue({ hasDebt: false, invoiceIds: [] }) },
        },
        { provide: DefiPolicyService, useValue: { authorizeSigning: jest.fn(), recordDenied: jest.fn() } },
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

  it('includes USDT in deposit tokens when the chain supports it', async () => {
    const supportedChain = getSupportedChain(8453);

    await expect(service.getDepositInfo('user-1', 8453)).resolves.toEqual({
      walletAddress: WALLET.walletAddress,
      chainId: 8453,
      chainName: supportedChain.name,
      status: 'active',
      supportedTokens: ['USDC', 'USDT', supportedChain.nativeCurrencySymbol],
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
