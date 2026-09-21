jest.mock('../../../core/openfort/openfort.service', () => ({
  OpenfortService: class OpenfortService {},
}));
jest.mock('../../session-key/session-key-policy.service', () => ({
  SessionKeyPolicyService: class SessionKeyPolicyService {},
}));
jest.mock('../../withdrawal-destination/withdrawal-destination-policy.service', () => ({
  WithdrawalDestinationPolicyService: class WithdrawalDestinationPolicyService {},
  isDeferredDestinationPolicyDenial: () => false,
}));
jest.mock('./usdc-payment.service', () => ({
  UsdcPaymentService: class UsdcPaymentService {},
}));

import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { API_ERROR_CODES } from '../../../common/errors/api-error-codes';
import {
  UsdcWalletPaymentService,
  WALLET_PAYMENT_QUOTE_EXPIRY_SAFETY_MS,
} from './usdc-wallet-payment.service';

const USER = 'user-1';
const INVOICE = 'inv-1';
const ATTEMPT = 'att-1';
const TREASURY = '0x1111111111111111111111111111111111111111';
const PAYER = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function baseInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE,
    billingAccountId: 'ba-1',
    status: 'finalized',
    paidAt: null,
    currency: 'USD',
    totalMicros: 5_000_000n,
    allocatedMicros: 0n,
    purpose: 'usage_period',
    periodStart: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

function baseAttempt(overrides: Record<string, unknown> = {}) {
  return {
    id: ATTEMPT,
    invoiceId: INVOICE,
    method: 'usdc',
    status: 'pending',
    amountMicros: 5_000_000n,
    currency: 'USD',
    chainId: 84532n,
    tokenAddress: TOKEN,
    treasuryAddress: TREASURY,
    tokenDecimals: 6,
    expectedBaseUnits: 5_000_000n,
    quoteExpiresAt: new Date(Date.now() + 60 * 60_000),
    expectedPayerAddress: PAYER.toLowerCase(),
    requiredConfirmations: 5,
    providerIdentity: 'abc',
    walletPaymentReserved: false,
    walletPaymentTransactionId: null,
    walletDispatchStartedAt: null,
    txHash: null,
    submittedTxHash: null,
    logIndex: null,
    actualBaseUnits: null,
    blockNumber: null,
    blockHash: null,
    reviewReason: null,
    ...overrides,
  };
}

describe('UsdcWalletPaymentService', () => {
  const prisma = {
    billingAccount: { findUnique: jest.fn() },
    billingInvoice: { findFirst: jest.fn(), findUnique: jest.fn(), findUniqueOrThrow: jest.fn() },
    billingPaymentAttempt: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
    },
    userWallet: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    walletChainAuthorization: { findFirst: jest.fn() },
    withdrawalPolicy: { findUnique: jest.fn() },
    transaction: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
  } as any;

  const config = {
    get: jest.fn((key: string) => {
      if (key === 'billing.usdc.enabled') return true;
      return undefined;
    }),
  } as any;

  const openfort = {
    submitUserOperation: jest.fn(),
    waitForUserOperationReceipt: jest.fn(),
  } as any;

  const usdcPayment = {
    claim: jest.fn(),
    claimFromWalletServerBinding: jest.fn(),
    assertWalletPayQuoteExecutable: jest.fn(),
  } as any;

  const destinationPolicy = {
    assertDestinationsAllowed: jest.fn().mockResolvedValue(undefined),
    acquireUserDestinationLock: jest.fn().mockResolvedValue(undefined),
    recordDeferredDenial: jest.fn().mockResolvedValue(undefined),
  } as any;

  const billingDebt = {
    getDebt: jest.fn().mockResolvedValue({ hasDebt: false, invoiceIds: [] }),
  } as any;

  const sessionKeyPolicy = {
    assertSessionKeyAllowed: jest.fn().mockResolvedValue(undefined),
  } as any;

  let service: UsdcWalletPaymentService;

  beforeEach(() => {
    jest.clearAllMocks();
    config.get.mockImplementation((key: string) =>
      key === 'billing.usdc.enabled' ? true : undefined,
    );
    prisma.billingAccount.findUnique.mockResolvedValue({ id: 'ba-1', userId: USER });
    prisma.billingInvoice.findFirst.mockResolvedValue(baseInvoice());
    prisma.billingPaymentAttempt.findFirst.mockResolvedValue(baseAttempt());
    prisma.userWallet.findUnique.mockResolvedValue({
      id: 'w1',
      status: 'active',
      frozenAt: null,
      walletAddress: PAYER.toLowerCase(),
      agentOpenfortAccountId: 'agent-1',
      agentKeyHash: '0x' + 'ab'.repeat(32),
      agentWalletAddress: '0x3333333333333333333333333333333333333333',
    });
    prisma.user.findUnique.mockResolvedValue({ frozenAt: null });
    prisma.walletChainAuthorization.findFirst.mockResolvedValue({
      status: 'registered',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    prisma.withdrawalPolicy.findUnique.mockResolvedValue({
      singleWithdrawalLimit: '10000000000',
      dailyWithdrawalLimit: null,
    });
    prisma.transaction.findMany.mockResolvedValue([]);
    destinationPolicy.assertDestinationsAllowed.mockResolvedValue(undefined);
    billingDebt.getDebt.mockResolvedValue({ hasDebt: false, invoiceIds: [] });
    usdcPayment.assertWalletPayQuoteExecutable.mockImplementation(() => undefined);
    usdcPayment.claimFromWalletServerBinding.mockResolvedValue(undefined);
    usdcPayment.claim.mockResolvedValue(undefined);
    service = new UsdcWalletPaymentService(
      prisma,
      config,
      openfort,
      usdcPayment,
      destinationPolicy,
      billingDebt,
      sessionKeyPolicy,
    );
  });

  it('rejects when USDC billing is disabled', async () => {
    config.get.mockReturnValue(false);
    await expect(service.payFromWallet(USER, INVOICE, ATTEMPT)).rejects.toThrow(
      /USDC billing is not enabled/,
    );
  });

  it('rejects when quote executable check fails (amount/snapshot)', async () => {
    usdcPayment.assertWalletPayQuoteExecutable.mockImplementation(() => {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_INVALID_ATTEMPT,
        message: 'Payment attempt amount no longer matches invoice remaining due',
      });
    });
    await expect(service.payFromWallet(USER, INVOICE, ATTEMPT)).rejects.toMatchObject({
      response: expect.objectContaining({ code: API_ERROR_CODES.USDC_INVALID_ATTEMPT }),
    });
    expect(openfort.submitUserOperation).not.toHaveBeenCalled();
  });

  it('rejects when quote expires within 5-minute safety margin', async () => {
    prisma.billingPaymentAttempt.findFirst.mockResolvedValue(
      baseAttempt({
        quoteExpiresAt: new Date(Date.now() + WALLET_PAYMENT_QUOTE_EXPIRY_SAFETY_MS - 1_000),
      }),
    );
    await expect(service.payFromWallet(USER, INVOICE, ATTEMPT)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.payFromWallet(USER, INVOICE, ATTEMPT)).rejects.toMatchObject({
      response: expect.objectContaining({ code: API_ERROR_CODES.USDC_QUOTE_EXPIRY_TOO_SOON }),
    });
    expect(openfort.submitUserOperation).not.toHaveBeenCalled();
  });

  it('blocks plan_charge wallet pay while usage debt exists', async () => {
    prisma.billingInvoice.findFirst.mockResolvedValue(baseInvoice({ purpose: 'plan_charge' }));
    billingDebt.getDebt.mockResolvedValue({ hasDebt: true, invoiceIds: ['usage-1'] });
    await expect(service.payFromWallet(USER, INVOICE, ATTEMPT)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.payFromWallet(USER, INVOICE, ATTEMPT)).rejects.toMatchObject({
      response: expect.objectContaining({ code: API_ERROR_CODES.USDC_WALLET_USAGE_DEBT_ONLY }),
    });
    expect(openfort.submitUserOperation).not.toHaveBeenCalled();
  });

  it('allows usage_period wallet pay while usage debt exists', async () => {
    billingDebt.getDebt.mockResolvedValue({ hasDebt: true, invoiceIds: [INVOICE] });
    // Short-circuit after preflight by returning already-reserved binding.
    prisma.billingPaymentAttempt.findFirst.mockResolvedValue(
      baseAttempt({
        walletPaymentReserved: true,
        walletPaymentTransactionId: 'tx-bound',
      }),
    );
    const result = await service.payFromWallet(USER, INVOICE, ATTEMPT);
    expect(result.accepted).toBe(true);
    expect(result.reserved).toBe(true);
    expect(result.paid).toBe(false);
    expect(openfort.submitUserOperation).not.toHaveBeenCalled();
  });

  it('returns idempotent state when already reserved (no second dispatch)', async () => {
    prisma.billingPaymentAttempt.findFirst.mockResolvedValue(
      baseAttempt({
        walletPaymentReserved: true,
        walletPaymentTransactionId: 'tx-1',
        status: 'confirming',
      }),
    );
    const result = await service.payFromWallet(USER, INVOICE, ATTEMPT);
    expect(result).toEqual(
      expect.objectContaining({
        accepted: true,
        reserved: true,
        paid: false,
        isExecutor: false,
        paymentAttemptId: ATTEMPT,
      }),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(openfort.submitUserOperation).not.toHaveBeenCalled();
  });

  it('B3: rejects quotes that already have submittedTxHash evidence', async () => {
    prisma.billingPaymentAttempt.findFirst.mockResolvedValue(
      baseAttempt({ submittedTxHash: '0x' + '11'.repeat(32) }),
    );
    await expect(service.payFromWallet(USER, INVOICE, ATTEMPT)).rejects.toMatchObject({
      response: expect.objectContaining({ code: API_ERROR_CODES.USDC_INVALID_ATTEMPT }),
    });
    expect(openfort.submitUserOperation).not.toHaveBeenCalled();
  });

  it('B4: rejects frozen UserWallet.frozenAt before provider', async () => {
    prisma.userWallet.findUnique.mockResolvedValue({
      id: 'w1',
      status: 'active',
      frozenAt: new Date(),
      walletAddress: PAYER.toLowerCase(),
      agentOpenfortAccountId: 'agent-1',
      agentKeyHash: '0x' + 'ab'.repeat(32),
      agentWalletAddress: '0x3333333333333333333333333333333333333333',
    });
    await expect(service.payFromWallet(USER, INVOICE, ATTEMPT)).rejects.toMatchObject({
      response: expect.objectContaining({ code: API_ERROR_CODES.USDC_WALLET_NOT_ACTIVE }),
    });
    expect(openfort.submitUserOperation).not.toHaveBeenCalled();
  });

  it('rejects frozen/missing payer wallet before provider', async () => {
    prisma.userWallet.findUnique.mockResolvedValue(null);
    await expect(service.payFromWallet(USER, INVOICE, ATTEMPT)).rejects.toMatchObject({
      response: expect.objectContaining({ code: API_ERROR_CODES.USDC_WALLET_NOT_ACTIVE }),
    });
    expect(openfort.submitUserOperation).not.toHaveBeenCalled();
  });

  it('rejects when destination policy denies treasury', async () => {
    destinationPolicy.assertDestinationsAllowed.mockRejectedValue(
      new ForbiddenException({
        code: API_ERROR_CODES.WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED,
        message: 'Withdrawal address is not allowlisted',
      }),
    );
    await expect(service.payFromWallet(USER, INVOICE, ATTEMPT)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: API_ERROR_CODES.WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED,
      }),
    });
    expect(openfort.submitUserOperation).not.toHaveBeenCalled();
  });

  it('getPaymentStatus returns safe fields without provider ids', async () => {
    prisma.billingPaymentAttempt.findFirst.mockResolvedValue(
      baseAttempt({
        walletPaymentReserved: true,
        walletPaymentTransactionId: 'tx-1',
        submittedTxHash: '0x' + 'ab'.repeat(32),
      }),
    );
    const status = await service.getPaymentStatus(USER, INVOICE, ATTEMPT);
    expect(status.reserved).toBe(true);
    expect(status.transactionHash).toMatch(/^0x/);
    expect(status).not.toHaveProperty('userOpHash');
    expect(status).not.toHaveProperty('requestHash');
    expect(JSON.stringify(status)).not.toMatch(/calldata|openfort/i);
  });

  it('reserves under locks then dispatches once and settles only via claim', async () => {
    const attempt = baseAttempt();
    const invoice = baseInvoice();
    prisma.billingPaymentAttempt.findFirst.mockResolvedValue(attempt);

    const createdTx = {
      id: 'tx-new',
      status: 'submitting',
      txHash: null,
      userOpHash: null,
    };

    prisma.$transaction.mockImplementation(async (cb: (tx: any) => Promise<unknown>) => {
      const txClient = {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([{ id: ATTEMPT }])
          .mockResolvedValueOnce([{ id: INVOICE }]),
        $executeRaw: jest.fn().mockResolvedValue(undefined),
        billingPaymentAttempt: {
          findUniqueOrThrow: jest
            .fn()
            .mockResolvedValueOnce(attempt)
            .mockResolvedValue({
              ...attempt,
              walletPaymentReserved: true,
              walletPaymentTransactionId: 'tx-new',
            }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        billingInvoice: {
          findUniqueOrThrow: jest.fn().mockResolvedValue(invoice),
        },
        userWallet: { findUnique: prisma.userWallet.findUnique },
        user: { findUnique: prisma.user.findUnique },
        walletChainAuthorization: {
          findFirst: prisma.walletChainAuthorization.findFirst,
        },
        withdrawalPolicy: { findUnique: prisma.withdrawalPolicy.findUnique },
        transaction: {
          create: jest.fn().mockResolvedValue(createdTx),
          findFirst: jest.fn(),
          findMany: jest.fn().mockResolvedValue([]),
        },
      };
      // acquireBillingPeriodAdvisoryLock uses $executeRaw on tx
      return cb(txClient);
    });

    // acquireBillingPeriodAdvisoryLock is called inside $transaction with tx
    // Mock it via the tx client's $executeRaw already.

    prisma.transaction.findFirst.mockResolvedValue(createdTx);
    openfort.submitUserOperation.mockResolvedValue({
      userOpHash: '0x' + 'cd'.repeat(32),
    });
    openfort.waitForUserOperationReceipt.mockResolvedValue({
      success: true,
      transactionHash: '0x' + 'ef'.repeat(32),
    });
    prisma.transaction.updateMany.mockResolvedValue({ count: 1 });
    const succeededClaim = {
      invoiceId: INVOICE,
      paymentAttemptId: ATTEMPT,
      status: 'succeeded',
      paid: true,
      txHash: '0x' + 'ef'.repeat(32),
      chainId: 84532,
      confirmations: 5,
      requiredConfirmations: 5,
      blockNumber: '1',
      blockHash: '0x' + '11'.repeat(32),
      blockTimestamp: '1',
      reviewReason: null,
      retryable: false,
    };
    usdcPayment.claimFromWalletServerBinding.mockResolvedValue(succeededClaim);

    // Post-commit reload for B4/B5
    prisma.billingInvoice.findFirst.mockResolvedValue(invoice);
    prisma.billingPaymentAttempt.findFirst
      .mockResolvedValueOnce(attempt)
      .mockResolvedValue(attempt);
    prisma.billingPaymentAttempt.findUniqueOrThrow.mockResolvedValue({
      ...attempt,
      walletPaymentReserved: true,
      walletPaymentTransactionId: 'tx-new',
    });

    prisma.billingPaymentAttempt.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.payFromWallet(USER, INVOICE, ATTEMPT);

    // B3: UserOp success/enclosing txHash must not auto-settle the invoice.
    expect(result.paid).toBe(false);
    expect(result.phase).toBe('unknown');
    expect(result.isExecutor).toBe(true);
    expect(result.reserved).toBe(true);
    expect(openfort.submitUserOperation).toHaveBeenCalledTimes(1);
    expect(usdcPayment.claimFromWalletServerBinding).not.toHaveBeenCalled();
    expect(usdcPayment.claim).not.toHaveBeenCalled();
    // B1: forensic enclosing hash — unknown status, never confirmed/completedAt.
    expect(prisma.transaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          txHash: '0x' + 'ef'.repeat(32),
          status: 'unknown',
          completedAt: null,
          userOpSuccess: true, // receipt.success===true recorded, still not settled
        }),
      }),
    );
    expect(prisma.billingPaymentAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'needs_review',
          reviewReason: expect.stringContaining('userop_unattributed'),
        }),
      }),
    );
  });

  it('B1: forensic hash with receipt.success=false never sets userOpSuccess=true/confirmed', async () => {
    const attempt = baseAttempt();
    prisma.billingPaymentAttempt.findFirst.mockResolvedValue(attempt);
    const createdTx = { id: 'tx-fail', status: 'submitting', txHash: null, userOpHash: null };
    prisma.$transaction.mockImplementation(async (cb: (tx: any) => Promise<unknown>) => {
      const txClient = {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([{ id: ATTEMPT }])
          .mockResolvedValueOnce([{ id: INVOICE }]),
        $executeRaw: jest.fn().mockResolvedValue(undefined),
        billingPaymentAttempt: {
          findUniqueOrThrow: jest
            .fn()
            .mockResolvedValueOnce(attempt)
            .mockResolvedValue({
              ...attempt,
              walletPaymentReserved: true,
              walletPaymentTransactionId: 'tx-fail',
            }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        billingInvoice: { findUniqueOrThrow: jest.fn().mockResolvedValue(baseInvoice()) },
        userWallet: { findUnique: prisma.userWallet.findUnique },
        user: { findUnique: prisma.user.findUnique },
        walletChainAuthorization: {
          findFirst: prisma.walletChainAuthorization.findFirst,
        },
        withdrawalPolicy: { findUnique: prisma.withdrawalPolicy.findUnique },
        transaction: {
          create: jest.fn().mockResolvedValue(createdTx),
          findMany: jest.fn().mockResolvedValue([]),
        },
      };
      return cb(txClient);
    });
    prisma.transaction.findFirst.mockResolvedValue(createdTx);
    openfort.submitUserOperation.mockResolvedValue({ userOpHash: '0x' + 'aa'.repeat(32) });
    openfort.waitForUserOperationReceipt.mockResolvedValue({
      success: false,
      transactionHash: '0x' + 'bb'.repeat(32),
    });
    prisma.transaction.updateMany.mockResolvedValue({ count: 1 });
    prisma.billingPaymentAttempt.updateMany.mockResolvedValue({ count: 1 });
    prisma.billingPaymentAttempt.findUniqueOrThrow.mockResolvedValue({
      ...attempt,
      walletPaymentReserved: true,
      walletPaymentTransactionId: 'tx-fail',
      status: 'needs_review',
      reviewReason: 'wallet_payment_userop_unattributed',
    });

    const result = await service.payFromWallet(USER, INVOICE, ATTEMPT);
    expect(result.paid).toBe(false);
    expect(result.reserved).toBe(true);
    expect(usdcPayment.claimFromWalletServerBinding).not.toHaveBeenCalled();
    expect(prisma.transaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          txHash: '0x' + 'bb'.repeat(32),
          status: 'unknown',
          userOpSuccess: false,
          completedAt: null,
        }),
      }),
    );
    // Must never mark confirmed/completed for failed forensic receipt.
    expect(prisma.transaction.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'confirmed', userOpSuccess: true }),
      }),
    );
  });

  it('B1: receipt.success=null with txHash stays forensic unknown (not confirmed)', async () => {
    const attempt = baseAttempt();
    prisma.billingPaymentAttempt.findFirst.mockResolvedValue(attempt);
    const createdTx = { id: 'tx-null', status: 'submitting', txHash: null, userOpHash: null };
    prisma.$transaction.mockImplementation(async (cb: (tx: any) => Promise<unknown>) => {
      const txClient = {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([{ id: ATTEMPT }])
          .mockResolvedValueOnce([{ id: INVOICE }]),
        $executeRaw: jest.fn().mockResolvedValue(undefined),
        billingPaymentAttempt: {
          findUniqueOrThrow: jest
            .fn()
            .mockResolvedValueOnce(attempt)
            .mockResolvedValue({
              ...attempt,
              walletPaymentReserved: true,
              walletPaymentTransactionId: 'tx-null',
            }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        billingInvoice: { findUniqueOrThrow: jest.fn().mockResolvedValue(baseInvoice()) },
        userWallet: { findUnique: prisma.userWallet.findUnique },
        user: { findUnique: prisma.user.findUnique },
        walletChainAuthorization: {
          findFirst: prisma.walletChainAuthorization.findFirst,
        },
        withdrawalPolicy: { findUnique: prisma.withdrawalPolicy.findUnique },
        transaction: {
          create: jest.fn().mockResolvedValue(createdTx),
          findMany: jest.fn().mockResolvedValue([]),
        },
      };
      return cb(txClient);
    });
    prisma.transaction.findFirst.mockResolvedValue(createdTx);
    openfort.submitUserOperation.mockResolvedValue({ userOpHash: '0x' + '11'.repeat(32) });
    openfort.waitForUserOperationReceipt.mockResolvedValue({
      success: null,
      transactionHash: '0x' + '22'.repeat(32),
    });
    prisma.transaction.updateMany.mockResolvedValue({ count: 1 });
    prisma.billingPaymentAttempt.updateMany.mockResolvedValue({ count: 1 });
    prisma.billingPaymentAttempt.findUniqueOrThrow.mockResolvedValue({
      ...attempt,
      walletPaymentReserved: true,
      status: 'needs_review',
      reviewReason: 'wallet_payment_userop_unattributed',
    });

    const result = await service.payFromWallet(USER, INVOICE, ATTEMPT);
    expect(result.paid).toBe(false);
    expect(prisma.transaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'unknown',
          userOpSuccess: null,
          completedAt: null,
          txHash: '0x' + '22'.repeat(32),
        }),
      }),
    );
  });

  it('retains reservation on unknown dispatch (no blind retry / no release)', async () => {
    const attempt = baseAttempt();
    prisma.billingPaymentAttempt.findFirst.mockResolvedValue(attempt);
    const createdTx = { id: 'tx-u', status: 'submitting', txHash: null, userOpHash: null };

    prisma.$transaction.mockImplementation(async (cb: (tx: any) => Promise<unknown>) => {
      const txClient = {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([{ id: ATTEMPT }])
          .mockResolvedValueOnce([{ id: INVOICE }]),
        $executeRaw: jest.fn().mockResolvedValue(undefined),
        billingPaymentAttempt: {
          findUniqueOrThrow: jest
            .fn()
            .mockResolvedValueOnce(attempt)
            .mockResolvedValue({
              ...attempt,
              walletPaymentReserved: true,
              walletPaymentTransactionId: 'tx-u',
            }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        billingInvoice: { findUniqueOrThrow: jest.fn().mockResolvedValue(baseInvoice()) },
        userWallet: { findUnique: prisma.userWallet.findUnique },
        user: { findUnique: prisma.user.findUnique },
        walletChainAuthorization: {
          findFirst: prisma.walletChainAuthorization.findFirst,
        },
        withdrawalPolicy: { findUnique: prisma.withdrawalPolicy.findUnique },
        transaction: {
          create: jest.fn().mockResolvedValue(createdTx),
          findMany: jest.fn().mockResolvedValue([]),
        },
      };
      return cb(txClient);
    });

    prisma.transaction.findFirst.mockResolvedValue(createdTx);
    openfort.submitUserOperation.mockRejectedValue(new Error('provider timeout'));
    prisma.transaction.updateMany.mockResolvedValue({ count: 1 });
    prisma.billingPaymentAttempt.updateMany.mockResolvedValue({ count: 1 });
    prisma.billingPaymentAttempt.findUniqueOrThrow.mockResolvedValue({
      ...attempt,
      walletPaymentReserved: true,
      walletPaymentTransactionId: 'tx-u',
      status: 'needs_review',
      reviewReason: 'wallet_payment_dispatch_unknown',
    });

    const result = await service.payFromWallet(USER, INVOICE, ATTEMPT);
    expect(result.accepted).toBe(true);
    expect(result.reserved).toBe(true);
    expect(result.paid).toBe(false);
    expect(result.status).toBe('needs_review');
    // Reservation retained — updateMany used for unknown marker, not expired/release.
    expect(prisma.billingPaymentAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'needs_review',
        }),
      }),
    );
    expect(usdcPayment.claim).not.toHaveBeenCalled();
  });

  // ── B8: aborted interactive TX must not continue queries / dispatch ────────

  it('non-P2002 create failure aborts reservation without further tx queries or dispatch', async () => {
    const attempt = baseAttempt();
    prisma.billingPaymentAttempt.findFirst.mockResolvedValue(attempt);

    let txFindFirstCalls = 0;
    let txUpdateManyCalls = 0;
    prisma.$transaction.mockImplementation(async (cb: (tx: any) => Promise<unknown>) => {
      const txClient = {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([{ id: ATTEMPT }])
          .mockResolvedValueOnce([{ id: INVOICE }]),
        $executeRaw: jest.fn().mockResolvedValue(undefined),
        billingPaymentAttempt: {
          findUniqueOrThrow: jest.fn().mockResolvedValue(attempt),
          updateMany: jest.fn().mockImplementation(async () => {
            txUpdateManyCalls += 1;
            return { count: 1 };
          }),
        },
        billingInvoice: { findUniqueOrThrow: jest.fn().mockResolvedValue(baseInvoice()) },
        userWallet: { findUnique: prisma.userWallet.findUnique },
        user: { findUnique: prisma.user.findUnique },
        walletChainAuthorization: {
          findFirst: prisma.walletChainAuthorization.findFirst,
        },
        withdrawalPolicy: { findUnique: prisma.withdrawalPolicy.findUnique },
        transaction: {
          create: jest.fn().mockRejectedValue(
            // Simulate CHECK/FK failure (not unique race) — aborts interactive TX.
            Object.assign(new Error('check constraint'), { code: 'P2003' }),
          ),
          findFirst: jest.fn().mockImplementation(async () => {
            txFindFirstCalls += 1;
            return null;
          }),
          findMany: jest.fn().mockResolvedValue([]),
        },
      };
      return cb(txClient);
    });

    await expect(service.payFromWallet(USER, INVOICE, ATTEMPT)).rejects.toMatchObject({
      code: 'P2003',
    });
    // Must not recover inside the aborted interactive TX.
    expect(txFindFirstCalls).toBe(0);
    expect(txUpdateManyCalls).toBe(0);
    // No root-client race recovery for non-P2002.
    expect(prisma.billingPaymentAttempt.findUnique).not.toHaveBeenCalled();
    expect(openfort.submitUserOperation).not.toHaveBeenCalled();
  });

  it('P2002 is resolved only after interactive TX rollback via root client', async () => {
    const attempt = baseAttempt();
    prisma.billingPaymentAttempt.findFirst.mockResolvedValue(attempt);

    const existingTx = {
      id: 'tx-existing',
      createdAt: new Date(),
      status: 'submitting',
      txHash: null,
      userOpHash: null,
    };

    let interactiveFindFirst = 0;
    prisma.$transaction.mockImplementation(async (cb: (tx: any) => Promise<unknown>) => {
      const txClient = {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([{ id: ATTEMPT }])
          .mockResolvedValueOnce([{ id: INVOICE }]),
        $executeRaw: jest.fn().mockResolvedValue(undefined),
        billingPaymentAttempt: {
          findUniqueOrThrow: jest.fn().mockResolvedValue(attempt),
          updateMany: jest.fn(),
        },
        billingInvoice: { findUniqueOrThrow: jest.fn().mockResolvedValue(baseInvoice()) },
        userWallet: { findUnique: prisma.userWallet.findUnique },
        user: { findUnique: prisma.user.findUnique },
        walletChainAuthorization: {
          findFirst: prisma.walletChainAuthorization.findFirst,
        },
        withdrawalPolicy: { findUnique: prisma.withdrawalPolicy.findUnique },
        transaction: {
          create: jest
            .fn()
            .mockRejectedValue(
              Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
            ),
          findFirst: jest.fn().mockImplementation(async () => {
            interactiveFindFirst += 1;
            return existingTx;
          }),
          findMany: jest.fn().mockResolvedValue([]),
        },
      };
      return cb(txClient);
    });

    // Post-rollback root client resolution.
    prisma.billingPaymentAttempt.findUnique.mockResolvedValue({
      ...attempt,
      walletPaymentReserved: false,
      walletPaymentTransactionId: null,
    });
    prisma.transaction.findFirst.mockResolvedValue(existingTx);
    prisma.billingPaymentAttempt.updateMany.mockResolvedValue({ count: 1 });
    prisma.billingPaymentAttempt.findUniqueOrThrow.mockResolvedValue({
      ...attempt,
      walletPaymentReserved: true,
      walletPaymentTransactionId: existingTx.id,
    });

    // Dispatch path after successful bind.
    prisma.transaction.findFirst
      .mockResolvedValueOnce(existingTx) // resolveReservationAfterUniqueRace
      .mockResolvedValueOnce(existingTx); // dispatchAndSettle load
    openfort.submitUserOperation.mockResolvedValue({ userOpHash: '0x' + 'cd'.repeat(32) });
    openfort.waitForUserOperationReceipt.mockResolvedValue({
      success: true,
      transactionHash: '0x' + 'ef'.repeat(32),
    });
    prisma.transaction.updateMany.mockResolvedValue({ count: 1 });
    // P2002 recovery is never executor — status only, no dispatch.
    const result = await service.payFromWallet(USER, INVOICE, ATTEMPT);
    expect(interactiveFindFirst).toBe(0); // no recovery queries on aborted tx client
    expect(prisma.billingPaymentAttempt.findUnique).toHaveBeenCalled(); // root client
    expect(result.isExecutor).toBe(false);
    expect(result.accepted).toBe(true);
    expect(openfort.submitUserOperation).not.toHaveBeenCalled();
  });

  it('H1: successful settle via submittedTxHash marks billingReconciledAt and clears nextCheckAt', async () => {
    const attempt = baseAttempt({
      walletPaymentReserved: true,
      walletPaymentTransactionId: 'tx-rec',
      submittedTxHash: '0x' + 'aa'.repeat(32),
      status: 'confirming',
    });
    const succeeded = { ...attempt, status: 'succeeded' as const };
    prisma.billingPaymentAttempt.findFirst.mockResolvedValue(attempt);
    prisma.billingPaymentAttempt.findUniqueOrThrow.mockResolvedValue(succeeded);
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-rec',
      status: 'pending',
      txHash: '0x' + 'aa'.repeat(32),
      userOpHash: null,
      billingReconciledAt: null,
    });
    prisma.transaction.updateMany.mockResolvedValue({ count: 1 });
    prisma.billingPaymentAttempt.updateMany.mockResolvedValue({ count: 1 });
    usdcPayment.claimFromWalletServerBinding.mockResolvedValue({
      invoiceId: INVOICE,
      paymentAttemptId: ATTEMPT,
      status: 'succeeded',
      paid: true,
      txHash: '0x' + 'aa'.repeat(32),
      chainId: 84532,
      confirmations: 5,
      requiredConfirmations: 5,
      blockNumber: '1',
      blockHash: '0x' + '11'.repeat(32),
      blockTimestamp: '1',
      reviewReason: null,
      retryable: false,
    });

    const result = await service.recoverReservedPayment(USER, INVOICE, ATTEMPT);
    expect(result.paid).toBe(true);
    expect(result.phase).toBe('paid');
    expect(prisma.transaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'tx-rec',
          operationType: 'billing_payment',
          billingReconciledAt: null,
        }),
        data: expect.objectContaining({ billingReconciledAt: expect.any(Date) }),
      }),
    );
    expect(prisma.billingPaymentAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ nextCheckAt: null }),
      }),
    );
  });

  it('B6: recoverReservedPayment with submittedTxHash uses server binding claim only', async () => {
    const attempt = baseAttempt({
      walletPaymentReserved: true,
      walletPaymentTransactionId: 'tx-rec',
      submittedTxHash: '0x' + 'aa'.repeat(32),
      status: 'needs_review',
      reviewReason: 'wallet_payment_dispatch_unknown',
    });
    const succeeded = {
      ...attempt,
      status: 'succeeded' as const,
      reviewReason: null,
    };
    prisma.billingPaymentAttempt.findFirst.mockResolvedValue(attempt);
    prisma.billingPaymentAttempt.findUniqueOrThrow.mockResolvedValue(succeeded);
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-rec',
      status: 'pending',
      txHash: '0x' + 'aa'.repeat(32),
      userOpHash: null,
    });
    prisma.transaction.updateMany.mockResolvedValue({ count: 1 });
    prisma.billingPaymentAttempt.updateMany.mockResolvedValue({ count: 1 });
    usdcPayment.claimFromWalletServerBinding.mockResolvedValue({
      invoiceId: INVOICE,
      paymentAttemptId: ATTEMPT,
      status: 'succeeded',
      paid: true,
      txHash: '0x' + 'aa'.repeat(32),
      chainId: 84532,
      confirmations: 5,
      requiredConfirmations: 5,
      blockNumber: '1',
      blockHash: '0x' + '11'.repeat(32),
      blockTimestamp: '1',
      reviewReason: null,
      retryable: false,
    });

    const result = await service.recoverReservedPayment(USER, INVOICE, ATTEMPT);
    expect(result.paid).toBe(true);
    expect(result.phase).toBe('paid');
    expect(usdcPayment.claimFromWalletServerBinding).toHaveBeenCalledWith(USER, INVOICE, {
      paymentAttemptId: ATTEMPT,
      txHash: '0x' + 'aa'.repeat(32),
      boundTransactionId: 'tx-rec',
    });
    expect(openfort.submitUserOperation).not.toHaveBeenCalled();
    expect(usdcPayment.claim).not.toHaveBeenCalled();
  });

  it('B3: recovery does not auto-settle from UserOp-observed enclosing txHash alone', async () => {
    const attempt = baseAttempt({
      walletPaymentReserved: true,
      walletPaymentTransactionId: 'tx-uop',
      submittedTxHash: null,
      status: 'needs_review',
      reviewReason: 'wallet_payment_userop_unattributed',
    });
    prisma.billingPaymentAttempt.findFirst.mockResolvedValue(attempt);
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-uop',
      status: 'pending',
      txHash: '0x' + 'ef'.repeat(32),
      userOpHash: '0x' + 'cd'.repeat(32),
    });
    prisma.billingPaymentAttempt.updateMany.mockResolvedValue({ count: 1 });
    prisma.billingPaymentAttempt.findUniqueOrThrow.mockResolvedValue(attempt);

    const result = await service.recoverReservedPayment(USER, INVOICE, ATTEMPT);
    expect(result.paid).toBe(false);
    expect(result.phase).toBe('unknown');
    expect(usdcPayment.claimFromWalletServerBinding).not.toHaveBeenCalled();
    expect(openfort.submitUserOperation).not.toHaveBeenCalled();
  });

  it('B1: under-lock evidence from client claim blocks reservation bind', async () => {
    const attempt = baseAttempt();
    prisma.billingPaymentAttempt.findFirst.mockResolvedValue(attempt);
    const withEvidence = baseAttempt({
      submittedTxHash: '0x' + '11'.repeat(32),
      status: 'confirming',
    });
    prisma.$transaction.mockImplementation(async (cb: (tx: any) => Promise<unknown>) => {
      const txClient = {
        $queryRaw: jest.fn().mockResolvedValueOnce([{ id: ATTEMPT }]),
        $executeRaw: jest.fn().mockResolvedValue(undefined),
        billingPaymentAttempt: {
          findUniqueOrThrow: jest.fn().mockResolvedValue(withEvidence),
        },
      };
      return cb(txClient);
    });

    await expect(service.payFromWallet(USER, INVOICE, ATTEMPT)).rejects.toMatchObject({
      response: expect.objectContaining({ code: API_ERROR_CODES.USDC_INVALID_ATTEMPT }),
    });
    expect(openfort.submitUserOperation).not.toHaveBeenCalled();
  });

  it('B4: expiry after session-key check skips provider and retains reservation', async () => {
    const longExpiry = new Date(Date.now() + 60 * 60_000);
    const shortExpiry = new Date(Date.now() + 2 * 60_000);
    const attempt = baseAttempt({ quoteExpiresAt: longExpiry });
    const reservedLong = {
      ...attempt,
      walletPaymentReserved: true as const,
      walletPaymentTransactionId: 'tx-exp',
      quoteExpiresAt: longExpiry,
    };
    const createdTx = { id: 'tx-exp', status: 'submitting', txHash: null, userOpHash: null };

    prisma.billingPaymentAttempt.findFirst.mockImplementation(async () => attempt);
    prisma.$transaction.mockImplementation(async (cb: (tx: any) => Promise<unknown>) => {
      const txClient = {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([{ id: ATTEMPT }])
          .mockResolvedValueOnce([{ id: INVOICE }]),
        $executeRaw: jest.fn().mockResolvedValue(undefined),
        billingPaymentAttempt: {
          findUniqueOrThrow: jest
            .fn()
            .mockResolvedValueOnce(attempt)
            .mockResolvedValue(reservedLong),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        billingInvoice: { findUniqueOrThrow: jest.fn().mockResolvedValue(baseInvoice()) },
        userWallet: { findUnique: prisma.userWallet.findUnique },
        user: { findUnique: prisma.user.findUnique },
        walletChainAuthorization: {
          findFirst: prisma.walletChainAuthorization.findFirst,
        },
        withdrawalPolicy: { findUnique: prisma.withdrawalPolicy.findUnique },
        transaction: {
          create: jest.fn().mockResolvedValue(createdTx),
          findMany: jest.fn().mockResolvedValue([]),
        },
      };
      const out = await cb(txClient);
      // After commit, loadOwned sees reserved + still-safe expiry.
      prisma.billingPaymentAttempt.findFirst.mockResolvedValue(reservedLong);
      return out;
    });
    prisma.transaction.findFirst.mockResolvedValue(createdTx);
    // Final pre-submit check (after session key) sees short expiry.
    let preSubmitChecks = 0;
    prisma.billingPaymentAttempt.findUniqueOrThrow.mockImplementation(async () => {
      preSubmitChecks += 1;
      if (preSubmitChecks === 1) {
        return { ...reservedLong, quoteExpiresAt: shortExpiry };
      }
      return {
        ...reservedLong,
        status: 'needs_review',
        reviewReason: 'wallet_payment_quote_expiry_before_dispatch',
      };
    });
    prisma.billingPaymentAttempt.updateMany.mockResolvedValue({ count: 1 });
    prisma.transaction.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.payFromWallet(USER, INVOICE, ATTEMPT);
    expect(result.paid).toBe(false);
    expect(result.phase).toBe('unknown');
    expect(openfort.submitUserOperation).not.toHaveBeenCalled();
  });

  it('B6: recoverReservedPayment with no hash retains needs_review without submit', async () => {
    const attempt = baseAttempt({
      walletPaymentReserved: true,
      walletPaymentTransactionId: 'tx-empty',
      status: 'needs_review',
      reviewReason: 'wallet_payment_dispatch_unknown',
    });
    prisma.billingPaymentAttempt.findFirst.mockResolvedValue(attempt);
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-empty',
      status: 'unknown',
      txHash: null,
      userOpHash: null,
    });
    prisma.billingPaymentAttempt.updateMany.mockResolvedValue({ count: 1 });
    prisma.billingPaymentAttempt.findUniqueOrThrow.mockReset();
    prisma.billingPaymentAttempt.findUniqueOrThrow.mockResolvedValue({
      ...attempt,
      walletPaymentReserved: true,
      walletPaymentTransactionId: 'tx-empty',
      nextCheckAt: new Date(),
    });

    const result = await service.recoverReservedPayment(USER, INVOICE, ATTEMPT);
    expect(result.phase).toBe('unknown');
    expect(result.reserved).toBe(true);
    expect(result.accepted).toBe(true);
    expect(openfort.submitUserOperation).not.toHaveBeenCalled();
    expect(prisma.billingPaymentAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ walletPaymentReserved: true }),
        data: expect.objectContaining({ status: 'needs_review' }),
      }),
    );
  });

  it('B1: concurrent logical second pay does not dispatch when already reserved', async () => {
    prisma.billingPaymentAttempt.findFirst.mockResolvedValue(
      baseAttempt({
        walletPaymentReserved: true,
        walletPaymentTransactionId: 'tx-bound',
        walletDispatchStartedAt: new Date(),
      }),
    );
    const a = await service.payFromWallet(USER, INVOICE, ATTEMPT);
    const b = await service.payFromWallet(USER, INVOICE, ATTEMPT);
    expect(a.isExecutor).toBe(false);
    expect(b.isExecutor).toBe(false);
    expect(openfort.submitUserOperation).not.toHaveBeenCalled();
  });

  it('B4: payer address mutation between reserve and dispatch retains unknown without submit', async () => {
    const attempt = baseAttempt();
    prisma.billingPaymentAttempt.findFirst.mockResolvedValue(attempt);
    const createdTx = { id: 'tx-mut', status: 'submitting', txHash: null, userOpHash: null };

    prisma.transaction.findFirst.mockResolvedValue(createdTx);
    // Matching payer through preflight+reserve; mutate only after $transaction.
    const matchingWallet = {
      id: 'w1',
      status: 'active',
      frozenAt: null,
      walletAddress: PAYER.toLowerCase(),
      agentOpenfortAccountId: 'agent-1',
      agentKeyHash: '0x' + 'ab'.repeat(32),
      agentWalletAddress: '0x3333333333333333333333333333333333333333',
    };
    const mutatedWallet = {
      ...matchingWallet,
      walletAddress: '0x9999999999999999999999999999999999999999',
    };
    let afterReserve = false;
    prisma.$transaction.mockImplementation(async (cb: (tx: any) => Promise<unknown>) => {
      const txClient = {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([{ id: ATTEMPT }])
          .mockResolvedValueOnce([{ id: INVOICE }]),
        $executeRaw: jest.fn().mockResolvedValue(undefined),
        billingPaymentAttempt: {
          findUniqueOrThrow: jest
            .fn()
            .mockResolvedValueOnce(attempt)
            .mockResolvedValue({
              ...attempt,
              walletPaymentReserved: true,
              walletPaymentTransactionId: 'tx-mut',
            }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        billingInvoice: { findUniqueOrThrow: jest.fn().mockResolvedValue(baseInvoice()) },
        userWallet: {
          findUnique: jest.fn().mockResolvedValue(matchingWallet),
        },
        user: { findUnique: prisma.user.findUnique },
        walletChainAuthorization: {
          findFirst: prisma.walletChainAuthorization.findFirst,
        },
        withdrawalPolicy: { findUnique: prisma.withdrawalPolicy.findUnique },
        transaction: {
          create: jest.fn().mockResolvedValue(createdTx),
          findMany: jest.fn().mockResolvedValue([]),
        },
      };
      const out = await cb(txClient);
      afterReserve = true;
      return out;
    });
    prisma.userWallet.findUnique.mockImplementation(async () =>
      afterReserve ? mutatedWallet : matchingWallet,
    );
    prisma.billingPaymentAttempt.updateMany.mockResolvedValue({ count: 1 });
    prisma.transaction.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.payFromWallet(USER, INVOICE, ATTEMPT)).rejects.toMatchObject({
      response: expect.objectContaining({ code: API_ERROR_CODES.USDC_INVALID_ATTEMPT }),
    });
    expect(openfort.submitUserOperation).not.toHaveBeenCalled();
    expect(prisma.billingPaymentAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'needs_review' }),
      }),
    );
  });

  it('B2: timeout/no-hash recovery retains reservation without submit or auto-pay', async () => {
    const attempt = baseAttempt({
      walletPaymentReserved: true,
      walletPaymentTransactionId: 'tx-empty',
      walletDispatchStartedAt: new Date(Date.now() - 20 * 60_000),
      status: 'needs_review',
      reviewReason: 'wallet_payment_dispatch_unknown',
    });
    prisma.billingPaymentAttempt.findFirst.mockResolvedValue(attempt);
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-empty',
      status: 'unknown',
      txHash: null,
      userOpHash: null,
      billingReconciledAt: null,
    });
    prisma.billingPaymentAttempt.updateMany.mockResolvedValue({ count: 1 });
    prisma.billingPaymentAttempt.findUniqueOrThrow.mockResolvedValue({
      ...attempt,
      walletPaymentReserved: true,
      nextCheckAt: new Date(),
    });

    const result = await service.recoverReservedPayment(USER, INVOICE, ATTEMPT);
    expect(result.paid).toBe(false);
    expect(result.reserved).toBe(true);
    expect(result.phase).toBe('unknown');
    expect(openfort.submitUserOperation).not.toHaveBeenCalled();
    expect(usdcPayment.claimFromWalletServerBinding).not.toHaveBeenCalled();
  });

  it('B2: late server-bound hash recovery reaches paid via server claim', async () => {
    const hash = '0x' + 'bb'.repeat(32);
    const attempt = baseAttempt({
      walletPaymentReserved: true,
      walletPaymentTransactionId: 'tx-late',
      submittedTxHash: hash,
      status: 'needs_review',
      reviewReason: 'wallet_payment_awaiting_evidence',
      walletDispatchStartedAt: new Date(Date.now() - 20 * 60_000),
    });
    prisma.billingPaymentAttempt.findFirst.mockResolvedValue(attempt);
    prisma.billingPaymentAttempt.findUniqueOrThrow.mockResolvedValue({
      ...attempt,
      status: 'succeeded',
      reviewReason: null,
    });
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-late',
      status: 'confirmed',
      txHash: hash,
      userOpHash: null,
      billingReconciledAt: null,
    });
    prisma.transaction.updateMany.mockResolvedValue({ count: 1 });
    prisma.billingPaymentAttempt.updateMany.mockResolvedValue({ count: 1 });
    usdcPayment.claimFromWalletServerBinding.mockResolvedValue({
      invoiceId: INVOICE,
      paymentAttemptId: ATTEMPT,
      status: 'succeeded',
      paid: true,
      txHash: hash,
      chainId: 84532,
      confirmations: 5,
      requiredConfirmations: 5,
      blockNumber: '10',
      blockHash: '0x' + 'cc'.repeat(32),
      blockTimestamp: '1',
      reviewReason: null,
      retryable: false,
    });

    const result = await service.recoverReservedPayment(USER, INVOICE, ATTEMPT);
    expect(result.paid).toBe(true);
    expect(result.phase).toBe('paid');
    expect(usdcPayment.claimFromWalletServerBinding).toHaveBeenCalledWith(USER, INVOICE, {
      paymentAttemptId: ATTEMPT,
      txHash: hash,
      boundTransactionId: 'tx-late',
    });
    expect(openfort.submitUserOperation).not.toHaveBeenCalled();
  });

  it('B2: active dispatch lease is not stolen into needs_review by recovery', async () => {
    const attempt = baseAttempt({
      walletPaymentReserved: true,
      walletPaymentTransactionId: 'tx-live',
      walletDispatchStartedAt: new Date(), // within lease
      status: 'pending',
      submittedTxHash: null,
      txHash: null,
    });
    prisma.billingPaymentAttempt.findFirst.mockResolvedValue(attempt);
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-live',
      status: 'submitting',
      txHash: null,
      userOpHash: null,
    });

    const result = await service.recoverReservedPayment(USER, INVOICE, ATTEMPT);
    expect(result.phase).toBe('submitting');
    expect(result.reserved).toBe(true);
    expect(result.paid).toBe(false);
    expect(prisma.billingPaymentAttempt.updateMany).not.toHaveBeenCalled();
    expect(usdcPayment.claimFromWalletServerBinding).not.toHaveBeenCalled();
    expect(openfort.submitUserOperation).not.toHaveBeenCalled();
  });

  it('B2: crash after settlement before marker repairs billingReconciledAt', async () => {
    const hash = '0x' + 'dd'.repeat(32);
    const attempt = baseAttempt({
      walletPaymentReserved: true,
      walletPaymentTransactionId: 'tx-paid',
      submittedTxHash: hash,
      txHash: hash,
      status: 'succeeded',
    });
    prisma.billingInvoice.findFirst.mockResolvedValue(
      baseInvoice({
        paidAt: new Date(),
        settlementAttemptId: ATTEMPT,
        status: 'paid',
      }),
    );
    prisma.billingPaymentAttempt.findFirst.mockResolvedValue(attempt);
    prisma.billingPaymentAttempt.findUniqueOrThrow.mockResolvedValue(attempt);
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-paid',
      status: 'confirmed',
      txHash: hash,
      userOpHash: null,
      billingReconciledAt: null,
    });
    prisma.transaction.updateMany.mockResolvedValue({ count: 1 });
    prisma.billingPaymentAttempt.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.recoverReservedPayment(USER, INVOICE, ATTEMPT);
    expect(result.paid).toBe(true);
    expect(result.phase).toBe('paid');
    expect(usdcPayment.claimFromWalletServerBinding).not.toHaveBeenCalled();
    expect(prisma.transaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'tx-paid',
          billingReconciledAt: null,
          txHash: { not: null },
        }),
        data: expect.objectContaining({ billingReconciledAt: expect.any(Date) }),
      }),
    );
    expect(prisma.billingPaymentAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ nextCheckAt: null }),
      }),
    );
  });

  it('B2: manual evidence-conflict review does not auto-pay when claim stays locked', async () => {
    const hash = '0x' + 'ee'.repeat(32);
    const attempt = baseAttempt({
      walletPaymentReserved: true,
      walletPaymentTransactionId: 'tx-conflict',
      submittedTxHash: hash,
      status: 'needs_review',
      reviewReason: 'amount_mismatch',
      walletDispatchStartedAt: new Date(Date.now() - 20 * 60_000),
    });
    prisma.billingPaymentAttempt.findFirst.mockResolvedValue(attempt);
    prisma.billingPaymentAttempt.findUniqueOrThrow.mockResolvedValue(attempt);
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-conflict',
      status: 'confirmed',
      txHash: hash,
      userOpHash: null,
    });
    usdcPayment.claimFromWalletServerBinding.mockResolvedValue({
      invoiceId: INVOICE,
      paymentAttemptId: ATTEMPT,
      status: 'needs_review',
      paid: false,
      txHash: hash,
      chainId: 84532,
      confirmations: null,
      requiredConfirmations: 5,
      blockNumber: null,
      blockHash: null,
      blockTimestamp: null,
      reviewReason: 'amount_mismatch',
      retryable: false,
    });

    const result = await service.recoverReservedPayment(USER, INVOICE, ATTEMPT);
    expect(result.paid).toBe(false);
    expect(result.phase).toBe('unknown');
    expect(usdcPayment.claimFromWalletServerBinding).toHaveBeenCalled();
    // Marker must not be written for unpaid conflict review.
    expect(prisma.transaction.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ billingReconciledAt: expect.any(Date) }),
      }),
    );
  });

  it('B3: recovery does not overwrite tx_hash_conflict into userop_unattributed', async () => {
    const attempt = baseAttempt({
      walletPaymentReserved: true,
      walletPaymentTransactionId: 'tx-conflict',
      status: 'needs_review',
      reviewReason: 'wallet_payment_tx_hash_conflict',
      walletDispatchStartedAt: new Date(Date.now() - 20 * 60_000),
    });
    prisma.billingPaymentAttempt.findFirst.mockResolvedValue(attempt);
    prisma.billingPaymentAttempt.findUniqueOrThrow.mockResolvedValue(attempt);
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-conflict',
      status: 'unknown',
      txHash: '0x' + 'aa'.repeat(32),
      userOpHash: '0x' + 'bb'.repeat(32),
    });
    openfort.waitForUserOperationReceipt.mockResolvedValue({
      success: true,
      transactionHash: '0x' + 'cc'.repeat(32),
    });
    prisma.billingPaymentAttempt.updateMany.mockResolvedValue({ count: 0 }); // soft CAS miss
    prisma.transaction.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.recoverReservedPayment(USER, INVOICE, ATTEMPT);
    expect(result.paid).toBe(false);
    expect(usdcPayment.claimFromWalletServerBinding).not.toHaveBeenCalled();
    // Soft reason write must include allowed-prior CAS (conflict reasons excluded).
    expect(prisma.billingPaymentAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { reviewReason: null },
            { reviewReason: { in: expect.any(Array) } },
          ]),
        }),
        data: expect.objectContaining({
          reviewReason: 'wallet_payment_userop_unattributed',
        }),
      }),
    );
    // Final attempt still shows conflict reason (CAS count 0 / findUnique returns original).
    expect(result.reviewReason).toBe('wallet_payment_tx_hash_conflict');
  });

  it('B2: unattributed UserOp recovery never auto-pays even with enclosing hash', async () => {
    const attempt = baseAttempt({
      walletPaymentReserved: true,
      walletPaymentTransactionId: 'tx-uo',
      status: 'needs_review',
      reviewReason: 'wallet_payment_userop_unattributed',
      walletDispatchStartedAt: new Date(Date.now() - 20 * 60_000),
      submittedTxHash: null,
    });
    prisma.billingPaymentAttempt.findFirst.mockResolvedValue(attempt);
    prisma.billingPaymentAttempt.findUniqueOrThrow.mockResolvedValue(attempt);
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-uo',
      status: 'unknown',
      txHash: '0x' + 'dd'.repeat(32),
      userOpHash: '0x' + 'ee'.repeat(32),
      userOpSuccess: null,
      completedAt: null,
    });
    openfort.waitForUserOperationReceipt.mockResolvedValue({
      success: true,
      transactionHash: '0x' + 'dd'.repeat(32),
    });
    prisma.transaction.updateMany.mockResolvedValue({ count: 1 });
    prisma.billingPaymentAttempt.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.recoverReservedPayment(USER, INVOICE, ATTEMPT);
    expect(result.paid).toBe(false);
    expect(result.phase).toBe('unknown');
    expect(usdcPayment.claimFromWalletServerBinding).not.toHaveBeenCalled();
    expect(openfort.submitUserOperation).not.toHaveBeenCalled();
  });

  it('B1: prior-day forensic-hash unknown reservation still counts toward daily limit', async () => {
    const attempt = baseAttempt();
    prisma.billingPaymentAttempt.findFirst.mockResolvedValue(attempt);
    prisma.withdrawalPolicy.findUnique.mockResolvedValue({
      singleWithdrawalLimit: '10000000000',
      dailyWithdrawalLimit: '5000000', // 5 USDC
    });
    // Prior-day unresolved forensic reservation (unknown + forensic hash).
    const priorDay = new Date(Date.now() - 36 * 60 * 60_000);
    prisma.transaction.findMany
      .mockResolvedValueOnce([]) // day-bounded
      .mockResolvedValueOnce([
        {
          id: 'tx-old-forensic',
          details: { token: 'USDC', amount: '5000000' },
        },
      ]);

    // Trigger limit check via preflight (payFromWallet path before reserve).
    await expect(service.payFromWallet(USER, INVOICE, ATTEMPT)).rejects.toThrow(
      /daily withdrawal limit/i,
    );
    expect(prisma.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['submitting', 'pending', 'unknown'] },
          createdAt: { lt: expect.any(Date) },
        }),
      }),
    );
    // Ensure prior-day fixture shape is what we counted (no confirmed success path).
    expect(priorDay.getTime()).toBeLessThan(Date.now());
  });
});
