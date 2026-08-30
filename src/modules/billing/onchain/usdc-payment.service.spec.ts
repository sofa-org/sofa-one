import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../core/database/prisma.service';
import { InvoiceSettlementService } from '../invoice-settlement.service';
import { USDC_RECEIPT_PROVIDER, USDC_TRANSFER_TOPIC0 } from './usdc.constants';
import { UsdcPaymentService } from './usdc-payment.service';
import type { UsdcReceipt, UsdcReceiptLog } from './usdc-receipt.provider';

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });

const ACCOUNT = {
  id: 'acc-1',
  userId: 'user-1',
  stripeCustomerId: null,
  currency: 'USD',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const PAYER = '0x3333333333333333333333333333333333333333';
const TREASURY_8453 = '0x1111111111111111111111111111111111111111';
const TREASURY_84532 = '0x2222222222222222222222222222222222222222';
const TOKEN_8453 = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // canonical Base USDC
const TOKEN_84532 = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // canonical Base Sepolia USDC
const TX_HASH = '0x' + 'a'.repeat(64);
const BLOCK_HASH = '0x' + 'b'.repeat(64);
const AMOUNT = 49_000_000n; // $49.00 at 6 decimals

// Non-secret provider identities derived from the mock RPC URLs (sha256 hex).
const PROVIDER_IDENTITY_8453 = createHash('sha256')
  .update('https://base.example.com/rpc')
  .digest('hex');
const PROVIDER_IDENTITY_84532 = createHash('sha256')
  .update('https://base-sepolia.example.com/rpc')
  .digest('hex');

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    billingAccountId: ACCOUNT.id,
    planVersionId: 'plan-1',
    periodStart: new Date('2026-05-01T00:00:00.000Z'),
    periodEnd: new Date('2026-06-01T00:00:00.000Z'),
    status: 'finalized',
    currency: 'USD',
    grossOutboundMicros: 0n,
    includedOutboundMicros: 0n,
    billableOutboundMicros: 0n,
    apiCalls: 0n,
    includedApiCalls: 0n,
    activeWallets: 0,
    includedWallets: 0,
    monthlyFeeMicros: AMOUNT,
    outboundOverageMicros: 0n,
    apiOverageMicros: 0n,
    walletOverageMicros: 0n,
    totalMicros: AMOUNT,
    snapshotJson: {},
    snapshotHash: 'hash',
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    finalizedAt: new Date('2026-06-01T00:00:00.000Z'),
    paidAt: null,
    paidVia: null,
    settlementAttemptId: null,
    ...overrides,
  };
}

function usdcAttempt(overrides: Record<string, unknown> = {}) {
  return {
    id: 'att-usdc',
    invoiceId: 'inv-1',
    method: 'usdc',
    status: 'pending',
    amountMicros: AMOUNT,
    currency: 'USD',
    stripeCheckoutSessionId: null,
    stripePaymentIntentId: null,
    checkoutUrl: null,
    failureCode: null,
    failureMessage: null,
    chainId: 8453n,
    tokenAddress: TOKEN_8453,
    treasuryAddress: TREASURY_8453,
    tokenDecimals: 6,
    expectedBaseUnits: AMOUNT,
    quoteExpiresAt: new Date(Date.now() + 3600_000),
    priceSource: 'usdc_6decimals',
    expectedPayerAddress: PAYER,
    requiredConfirmations: 5,
    providerIdentity: PROVIDER_IDENTITY_8453,
    txHash: null,
    logIndex: null,
    payerAddress: null,
    actualBaseUnits: null,
    blockNumber: null,
    blockHash: null,
    blockTimestamp: null,
    receiptEvidence: null,
    reviewReason: null,
    lastCheckedAt: null,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    succeededAt: null,
    failedAt: null,
    ...overrides,
  };
}

/** Builds a strictly ABI-encoded canonical USDC Transfer log. */
function transferLog(
  overrides: Partial<UsdcReceiptLog> & {
    token?: string;
    from?: string;
    to?: string;
    amount?: bigint;
  } = {},
): UsdcReceiptLog {
  const token = (overrides.token ?? TOKEN_8453).toLowerCase();
  const from = (overrides.from ?? PAYER).toLowerCase();
  const to = (overrides.to ?? TREASURY_8453).toLowerCase();
  const amount = overrides.amount ?? AMOUNT;
  return {
    address: token,
    topics: [
      USDC_TRANSFER_TOPIC0,
      '0x' + '0'.repeat(24) + from.slice(2),
      '0x' + '0'.repeat(24) + to.slice(2),
    ],
    data: '0x' + amount.toString(16).padStart(64, '0'),
    logIndex: 0,
    removed: false,
    ...overrides,
  };
}

function receipt(overrides: Partial<UsdcReceipt> & { logs?: UsdcReceiptLog[] } = {}): UsdcReceipt {
  return {
    status: 'success',
    transactionHash: TX_HASH,
    from: PAYER,
    to: TOKEN_8453,
    blockNumber: 100n,
    blockHash: BLOCK_HASH,
    // After the attempt's createdAt (2026-06-01T00:00:00Z = 1780272000) and
    // before the quote expiry, so the default receipt passes the new
    // chain-time lower-bound check.
    blockTimestamp: 1_785_000_000n,
    logs: [transferLog()],
    ...overrides,
  };
}

describe('UsdcPaymentService', () => {
  let service: UsdcPaymentService;

  const accountFindUnique = jest.fn();
  const invoiceFindFirst = jest.fn();
  const attemptFindFirst = jest.fn();
  const attemptFindUnique = jest.fn();
  const attemptCreate = jest.fn();
  const attemptUpdate = jest.fn();
  const attemptUpdateMany = jest.fn();
  const walletFindUnique = jest.fn();
  const txQueryRaw = jest.fn();
  const txAttemptUpdate = jest.fn();
  const txAttemptFindUnique = jest.fn();
  const txInvoiceFindUnique = jest.fn();
  const settleInvoice = jest.fn();
  const getTransactionReceipt = jest.fn();
  const getBlockNumber = jest.fn();
  const configGet = jest.fn();

  const prisma = {
    billingAccount: { findUnique: accountFindUnique },
    billingInvoice: { findFirst: invoiceFindFirst },
    billingPaymentAttempt: {
      findFirst: attemptFindFirst,
      findUnique: attemptFindUnique,
      create: attemptCreate,
      update: attemptUpdate,
      updateMany: attemptUpdateMany,
    },
    userWallet: { findUnique: walletFindUnique },
    $transaction: jest.fn(),
  };

  const tx = {
    $queryRaw: txQueryRaw,
    billingPaymentAttempt: { update: txAttemptUpdate, findUnique: txAttemptFindUnique },
    billingInvoice: { findUnique: txInvoiceFindUnique },
  };

  const receiptProvider = { getTransactionReceipt, getBlockNumber };
  const settlementService = { settleInvoice };

  beforeEach(async () => {
    jest.resetAllMocks();

    configGet.mockImplementation((key: string) => {
      const values: Record<string, unknown> = {
        'billing.usdc.enabled': true,
        'billing.usdc.treasuryAddresses.8453': TREASURY_8453,
        'billing.usdc.treasuryAddresses.84532': TREASURY_84532,
        'billing.usdc.rpcUrls.8453': 'https://base.example.com/rpc',
        'billing.usdc.rpcUrls.84532': 'https://base-sepolia.example.com/rpc',
        'billing.usdc.requiredConfirmations': 5,
        'billing.usdc.quoteTtlSeconds': 86400,
        'chain.defaultChainId': 84532,
      };
      return values[key];
    });

    prisma.$transaction.mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) =>
      fn(tx),
    );
    // The settlement transaction takes stable row locks (attempt → invoice)
    // before re-reading the attempt under the lock.
    txQueryRaw.mockImplementation((strings: TemplateStringsArray) => {
      const sql = strings.join('');
      if (sql.includes('billing_payment_attempts')) return Promise.resolve([{ id: 'att-usdc' }]);
      if (sql.includes('billing_invoices')) return Promise.resolve([{ id: 'inv-1' }]);
      return Promise.resolve([]);
    });
    txAttemptFindUnique.mockResolvedValue(usdcAttempt());
    attemptUpdateMany.mockResolvedValue({ count: 1 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsdcPaymentService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: configGet } },
        { provide: InvoiceSettlementService, useValue: settlementService },
        { provide: USDC_RECEIPT_PROVIDER, useValue: receiptProvider },
      ],
    }).compile();

    service = module.get<UsdcPaymentService>(UsdcPaymentService);
  });

  describe('quote — feature flag and ownership', () => {
    it('fails closed with 503 when USDC billing is disabled', async () => {
      configGet.mockImplementation((key: string) =>
        key === 'billing.usdc.enabled' ? false : undefined,
      );

      await expect(service.quote('user-1', 'inv-1')).rejects.toThrow(ServiceUnavailableException);
    });

    it('throws NotFound when the user has no billing account', async () => {
      accountFindUnique.mockResolvedValue(null);

      await expect(service.quote('user-1', 'inv-1')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFound when the invoice is not owned by the user', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(null);

      await expect(service.quote('user-1', 'inv-other')).rejects.toThrow(NotFoundException);
    });

    it('rejects non-finalized invoices', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice({ status: 'open' }));

      await expect(service.quote('user-1', 'inv-1')).rejects.toThrow(ConflictException);
    });

    it('rejects already-paid invoices', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice({ paidAt: new Date() }));

      await expect(service.quote('user-1', 'inv-1')).rejects.toThrow(ConflictException);
    });

    it('rejects non-USD invoices', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice({ currency: 'EUR' }));

      await expect(service.quote('user-1', 'inv-1')).rejects.toThrow(BadRequestException);
    });

    it('rejects zero-amount invoices', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice({ totalMicros: 0n }));

      await expect(service.quote('user-1', 'inv-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('quote — chain selection and server-derived facts', () => {
    beforeEach(() => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice());
      walletFindUnique.mockResolvedValue({
        userId: 'user-1',
        walletAddress: PAYER,
        status: 'active',
        frozenAt: null,
      });
      attemptFindFirst.mockResolvedValue(null);
      attemptCreate.mockResolvedValue(usdcAttempt());
    });

    it('rejects a chain outside the USDC billing allowlist', async () => {
      await expect(service.quote('user-1', 'inv-1', 1)).rejects.toThrow(BadRequestException);
    });

    it('rejects a chain without configured treasury/RPC', async () => {
      configGet.mockImplementation((key: string) => {
        if (key === 'billing.usdc.treasuryAddresses.8453') return undefined;
        return key === 'billing.usdc.enabled' ? true : undefined;
      });

      await expect(service.quote('user-1', 'inv-1', 8453)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('derives canonical token, treasury, payer, decimals, and exact amount from server state', async () => {
      const result = await service.quote('user-1', 'inv-1', 8453);

      expect(attemptCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          invoiceId: 'inv-1',
          method: 'usdc',
          status: 'pending',
          amountMicros: AMOUNT,
          currency: 'USD',
          chainId: 8453n,
          tokenAddress: TOKEN_8453,
          treasuryAddress: TREASURY_8453,
          tokenDecimals: 6,
          expectedBaseUnits: AMOUNT,
          expectedPayerAddress: PAYER,
          requiredConfirmations: 5,
          providerIdentity: PROVIDER_IDENTITY_8453,
          priceSource: 'usdc_6decimals',
        }),
      });
      expect(result).toEqual(
        expect.objectContaining({
          invoiceId: 'inv-1',
          paymentAttemptId: 'att-usdc',
          chainId: 8453,
          tokenAddress: TOKEN_8453,
          tokenDecimals: 6,
          treasuryAddress: TREASURY_8453,
          expectedPayerAddress: PAYER,
          amountBaseUnits: AMOUNT.toString(),
          amountUsd: '49',
          currency: 'USD',
          requiredConfirmations: 5,
        }),
      );
    });

    it('defaults to the configured default chain when no selector is given', async () => {
      await service.quote('user-1', 'inv-1');

      expect(attemptCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          chainId: 84532n,
          tokenAddress: TOKEN_84532,
          treasuryAddress: TREASURY_84532,
          providerIdentity: PROVIDER_IDENTITY_84532,
        }),
      });
    });

    it('rejects when the user has no active wallet', async () => {
      walletFindUnique.mockResolvedValue(null);

      await expect(service.quote('user-1', 'inv-1')).rejects.toThrow(ConflictException);
    });

    it('rejects a frozen wallet as the payer', async () => {
      walletFindUnique.mockResolvedValue({
        userId: 'user-1',
        walletAddress: PAYER,
        status: 'active',
        frozenAt: new Date(),
      });

      await expect(service.quote('user-1', 'inv-1')).rejects.toThrow(ConflictException);
    });

    it('never returns logs, calldata, RPC details, or secrets in the quote', async () => {
      const result = await service.quote('user-1', 'inv-1', 8453);

      const keys = Object.keys(result);
      expect(keys).not.toContain('logs');
      expect(keys).not.toContain('calldata');
      expect(keys).not.toContain('rpcUrl');
      expect(keys).not.toContain('openfortAccountId');
      expect(keys).not.toContain('secret');
      expect(JSON.stringify(result)).not.toContain('https://');
    });
  });

  describe('quote — concurrency and reuse', () => {
    beforeEach(() => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice());
      walletFindUnique.mockResolvedValue({
        userId: 'user-1',
        walletAddress: PAYER,
        status: 'active',
        frozenAt: null,
      });
    });

    it('reuses an existing compatible pending attempt idempotently', async () => {
      attemptFindFirst.mockResolvedValue(usdcAttempt());

      const result = await service.quote('user-1', 'inv-1', 8453);

      expect(attemptCreate).not.toHaveBeenCalled();
      expect(result.paymentAttemptId).toBe('att-usdc');
    });

    it('reuses a confirming attempt (mid-payment)', async () => {
      attemptFindFirst.mockResolvedValue(usdcAttempt({ status: 'confirming' }));

      const result = await service.quote('user-1', 'inv-1', 8453);

      expect(attemptCreate).not.toHaveBeenCalled();
      expect(result.paymentAttemptId).toBe('att-usdc');
    });

    it('releases an expired pending attempt and quotes fresh', async () => {
      attemptFindFirst.mockResolvedValue(
        usdcAttempt({ quoteExpiresAt: new Date(Date.now() - 1000) }),
      );
      attemptCreate.mockResolvedValue(usdcAttempt({ id: 'att-fresh' }));

      const result = await service.quote('user-1', 'inv-1', 8453);

      expect(attemptUpdateMany).toHaveBeenCalledWith({
        where: { id: 'att-usdc', status: 'pending' },
        data: expect.objectContaining({ status: 'expired', reviewReason: 'quote_expired' }),
      });
      expect(attemptCreate).toHaveBeenCalledTimes(1);
      expect(result.paymentAttemptId).toBe('att-fresh');
    });

    it('releases a pending attempt with an incomplete snapshot and quotes fresh', async () => {
      attemptFindFirst.mockResolvedValue(usdcAttempt({ providerIdentity: null }));
      attemptCreate.mockResolvedValue(usdcAttempt({ id: 'att-fresh' }));

      const result = await service.quote('user-1', 'inv-1', 8453);

      expect(attemptUpdateMany).toHaveBeenCalledWith({
        where: { id: 'att-usdc', status: 'pending' },
        data: expect.objectContaining({
          status: 'needs_review',
          reviewReason: 'snapshot_incomplete',
        }),
      });
      expect(attemptCreate).toHaveBeenCalledTimes(1);
      expect(result.paymentAttemptId).toBe('att-fresh');
    });

    it('reuses the attempt when a concurrent claim changed it before the release CAS', async () => {
      // The quote read an expired pending attempt, but a concurrent claim
      // confirmed it before the release CAS ran: the pending-only CAS matches
      // zero rows and the active attempt is reused — never overwritten.
      attemptFindFirst.mockResolvedValue(
        usdcAttempt({ quoteExpiresAt: new Date(Date.now() - 1000) }),
      );
      attemptUpdateMany.mockResolvedValue({ count: 0 });
      attemptFindUnique.mockResolvedValue(usdcAttempt({ status: 'confirming', txHash: TX_HASH }));

      const result = await service.quote('user-1', 'inv-1', 8453);

      expect(attemptCreate).not.toHaveBeenCalled();
      expect(result.paymentAttemptId).toBe('att-usdc');
    });

    it('conflicts when an active attempt exists on another chain', async () => {
      attemptFindFirst.mockResolvedValue(usdcAttempt({ chainId: 84532n }));

      await expect(service.quote('user-1', 'inv-1', 8453)).rejects.toThrow(ConflictException);
    });

    it('releases an expired pending attempt on another chain before rejecting (cross-chain expiry)', async () => {
      // An expired 8453 pending attempt must not permanently block a fresh
      // 84532 quote: the expired attempt is released first, then a new attempt
      // is created on the requested chain.
      attemptFindFirst.mockResolvedValue(
        usdcAttempt({ chainId: 8453n, quoteExpiresAt: new Date(Date.now() - 1000) }),
      );
      attemptCreate.mockResolvedValue(usdcAttempt({ id: 'att-84532', chainId: 84532n }));

      const result = await service.quote('user-1', 'inv-1', 84532);

      expect(attemptUpdateMany).toHaveBeenCalledWith({
        where: { id: 'att-usdc', status: 'pending' },
        data: expect.objectContaining({ status: 'expired', reviewReason: 'quote_expired' }),
      });
      expect(attemptCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ chainId: 84532n, status: 'pending' }),
      });
      expect(result.paymentAttemptId).toBe('att-84532');
    });

    it('never releases a non-expired confirming attempt on another chain', async () => {
      attemptFindFirst.mockResolvedValue(usdcAttempt({ chainId: 8453n, status: 'confirming' }));

      await expect(service.quote('user-1', 'inv-1', 84532)).rejects.toThrow(ConflictException);
      expect(attemptUpdateMany).not.toHaveBeenCalled();
    });

    it('reuses the concurrent winner on a P2002 insert race', async () => {
      attemptFindFirst.mockResolvedValue(null);
      attemptCreate.mockRejectedValueOnce(p2002());
      attemptFindFirst.mockResolvedValueOnce(usdcAttempt({ id: 'att-winner' }));

      const result = await service.quote('user-1', 'inv-1', 8453);

      expect(result.paymentAttemptId).toBe('att-winner');
    });

    it('never returns a concurrent winner on another chain from a release-CAS failure', async () => {
      // The quote read an expired pending attempt on 8453; a concurrent claim
      // confirmed it before the release CAS ran. The requested chain is 84532:
      // the active confirming attempt on 8453 must be a conflict, never reused.
      attemptFindFirst.mockResolvedValue(
        usdcAttempt({ chainId: 8453n, quoteExpiresAt: new Date(Date.now() - 1000) }),
      );
      attemptUpdateMany.mockResolvedValue({ count: 0 });
      attemptFindUnique.mockResolvedValue(
        usdcAttempt({ chainId: 8453n, status: 'confirming', txHash: TX_HASH }),
      );

      await expect(service.quote('user-1', 'inv-1', 84532)).rejects.toThrow(ConflictException);
      expect(attemptCreate).not.toHaveBeenCalled();
    });

    it('reuses a confirming winner on the requested chain even when its quote expired (insert race)', async () => {
      // A concurrent quote created a confirming attempt on 8453 whose quote has
      // since expired. The insert-race fallback must reuse it (confirming
      // attempts are never released), not treat it as expirable.
      attemptFindFirst.mockResolvedValue(null);
      attemptCreate.mockRejectedValueOnce(p2002());
      attemptFindFirst.mockResolvedValueOnce(
        usdcAttempt({
          id: 'att-winner',
          chainId: 8453n,
          status: 'confirming',
          quoteExpiresAt: new Date(Date.now() - 1000),
        }),
      );

      const result = await service.quote('user-1', 'inv-1', 8453);

      expect(result.paymentAttemptId).toBe('att-winner');
    });

    it('rejects a concurrent winner on another chain in the insert-race fallback', async () => {
      attemptFindFirst.mockResolvedValue(null);
      attemptCreate.mockRejectedValueOnce(p2002());
      attemptFindFirst.mockResolvedValueOnce(
        usdcAttempt({ id: 'att-winner', chainId: 8453n, status: 'pending' }),
      );

      await expect(service.quote('user-1', 'inv-1', 84532)).rejects.toThrow(ConflictException);
    });
  });

  describe('claim — ownership, method, and snapshot integrity', () => {
    beforeEach(() => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice());
      attemptFindUnique.mockResolvedValue(usdcAttempt());
    });

    it('fails closed with 503 when USDC billing is disabled', async () => {
      configGet.mockImplementation((key: string) =>
        key === 'billing.usdc.enabled' ? false : undefined,
      );

      await expect(
        service.claim('user-1', 'inv-1', { paymentAttemptId: 'att-usdc', txHash: TX_HASH }),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('throws NotFound when the attempt is not found', async () => {
      attemptFindUnique.mockResolvedValue(null);

      await expect(
        service.claim('user-1', 'inv-1', { paymentAttemptId: 'att-missing', txHash: TX_HASH }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFound when the attempt belongs to a different invoice', async () => {
      attemptFindUnique.mockResolvedValue(usdcAttempt({ invoiceId: 'inv-other' }));

      await expect(
        service.claim('user-1', 'inv-1', { paymentAttemptId: 'att-usdc', txHash: TX_HASH }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws Conflict when the attempt method is not usdc', async () => {
      attemptFindUnique.mockResolvedValue(usdcAttempt({ method: 'stripe' }));

      await expect(
        service.claim('user-1', 'inv-1', { paymentAttemptId: 'att-usdc', txHash: TX_HASH }),
      ).rejects.toThrow(ConflictException);
    });

    it('throws Conflict when the attempt amount does not match the invoice', async () => {
      attemptFindUnique.mockResolvedValue(usdcAttempt({ amountMicros: 48_000_000n }));

      await expect(
        service.claim('user-1', 'inv-1', { paymentAttemptId: 'att-usdc', txHash: TX_HASH }),
      ).rejects.toThrow(ConflictException);
    });

    it('throws Conflict when the quote snapshot is incomplete', async () => {
      attemptFindUnique.mockResolvedValue(usdcAttempt({ requiredConfirmations: null }));

      await expect(
        service.claim('user-1', 'inv-1', { paymentAttemptId: 'att-usdc', txHash: TX_HASH }),
      ).rejects.toThrow(ConflictException);
    });

    it('throws Conflict when the snapshot is missing the provider identity', async () => {
      attemptFindUnique.mockResolvedValue(usdcAttempt({ providerIdentity: null }));

      await expect(
        service.claim('user-1', 'inv-1', { paymentAttemptId: 'att-usdc', txHash: TX_HASH }),
      ).rejects.toThrow(ConflictException);
    });

    it('throws Conflict when the snapshot chain is outside the USDC allowlist', async () => {
      attemptFindUnique.mockResolvedValue(usdcAttempt({ chainId: 1n }));

      await expect(
        service.claim('user-1', 'inv-1', { paymentAttemptId: 'att-usdc', txHash: TX_HASH }),
      ).rejects.toThrow(ConflictException);
    });

    it('throws Conflict when the snapshot token is not canonical for the chain', async () => {
      attemptFindUnique.mockResolvedValue(usdcAttempt({ tokenAddress: '0x' + 'f'.repeat(40) }));

      await expect(
        service.claim('user-1', 'inv-1', { paymentAttemptId: 'att-usdc', txHash: TX_HASH }),
      ).rejects.toThrow(ConflictException);
    });

    it('throws Conflict when the snapshot treasury is the zero address', async () => {
      attemptFindUnique.mockResolvedValue(usdcAttempt({ treasuryAddress: '0x' + '0'.repeat(40) }));

      await expect(
        service.claim('user-1', 'inv-1', { paymentAttemptId: 'att-usdc', txHash: TX_HASH }),
      ).rejects.toThrow(ConflictException);
    });

    it('throws Conflict when the snapshot treasury does not match server config', async () => {
      attemptFindUnique.mockResolvedValue(usdcAttempt({ treasuryAddress: '0x' + '9'.repeat(40) }));

      await expect(
        service.claim('user-1', 'inv-1', { paymentAttemptId: 'att-usdc', txHash: TX_HASH }),
      ).rejects.toThrow(ConflictException);
    });

    it('throws Conflict when the snapshot payer is not a valid EVM address', async () => {
      attemptFindUnique.mockResolvedValue(usdcAttempt({ expectedPayerAddress: 'not-an-address' }));

      await expect(
        service.claim('user-1', 'inv-1', { paymentAttemptId: 'att-usdc', txHash: TX_HASH }),
      ).rejects.toThrow(ConflictException);
    });

    it('throws Conflict when the snapshot decimals are not 6', async () => {
      attemptFindUnique.mockResolvedValue(usdcAttempt({ tokenDecimals: 18 }));

      await expect(
        service.claim('user-1', 'inv-1', { paymentAttemptId: 'att-usdc', txHash: TX_HASH }),
      ).rejects.toThrow(ConflictException);
    });

    it('throws Conflict when the snapshot expected amount does not match the invoice', async () => {
      attemptFindUnique.mockResolvedValue(usdcAttempt({ expectedBaseUnits: 48_000_000n }));

      await expect(
        service.claim('user-1', 'inv-1', { paymentAttemptId: 'att-usdc', txHash: TX_HASH }),
      ).rejects.toThrow(ConflictException);
    });

    it('throws Conflict when the snapshot requires fewer than 5 confirmations', async () => {
      attemptFindUnique.mockResolvedValue(usdcAttempt({ requiredConfirmations: 4 }));

      await expect(
        service.claim('user-1', 'inv-1', { paymentAttemptId: 'att-usdc', txHash: TX_HASH }),
      ).rejects.toThrow(ConflictException);
    });

    it('throws Conflict when the snapshot provider identity does not match current config', async () => {
      attemptFindUnique.mockResolvedValue(usdcAttempt({ providerIdentity: '0'.repeat(64) }));

      await expect(
        service.claim('user-1', 'inv-1', { paymentAttemptId: 'att-usdc', txHash: TX_HASH }),
      ).rejects.toThrow(ConflictException);
    });

    it('returns the paid state idempotently for a succeeded attempt without RPC calls', async () => {
      attemptFindUnique.mockResolvedValue(
        usdcAttempt({ status: 'succeeded', succeededAt: new Date() }),
      );
      invoiceFindFirst.mockResolvedValue(invoice({ paidAt: new Date() }));

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('succeeded');
      expect(result.paid).toBe(true);
      expect(getTransactionReceipt).not.toHaveBeenCalled();
    });

    it('returns terminal expired/failed/needs_review states as-is', async () => {
      for (const [status, reviewReason] of [
        ['expired', 'quote_expired'],
        ['failed', null],
        ['needs_review', 'wrong_amount'],
      ] as const) {
        attemptFindUnique.mockResolvedValue(usdcAttempt({ status, reviewReason }));

        const result = await service.claim('user-1', 'inv-1', {
          paymentAttemptId: 'att-usdc',
          txHash: TX_HASH,
        });

        expect(result.status).toBe(status);
        expect(getTransactionReceipt).not.toHaveBeenCalled();
      }
    });
  });

  describe('claim — retryable receipt outcomes', () => {
    beforeEach(() => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice());
      attemptFindUnique.mockResolvedValue(usdcAttempt());
    });

    it('returns a retryable pending result when the receipt is not found', async () => {
      getTransactionReceipt.mockResolvedValue(null);

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('pending');
      expect(result.retryable).toBe(true);
      // The user-submitted hash is persisted before verification so a worker
      // retry can resume this claim across a process restart.
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ submittedTxHash: TX_HASH, nextCheckAt: expect.any(Date) }),
        }),
      );
    });

    it('returns a retryable rpc_error result on a transient RPC error', async () => {
      getTransactionReceipt.mockRejectedValue(new Error('rate limited'));

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('rpc_error');
      expect(result.retryable).toBe(true);
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ submittedTxHash: TX_HASH, nextCheckAt: expect.any(Date) }),
        }),
      );
    });

    it('marks the attempt expired when the quote window closed with no receipt', async () => {
      getTransactionReceipt.mockResolvedValue(null);
      attemptFindUnique.mockResolvedValue(
        usdcAttempt({ quoteExpiresAt: new Date(Date.now() - 1000) }),
      );

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('expired');
      expect(attemptUpdateMany).toHaveBeenCalledWith({
        where: { id: 'att-usdc', status: { in: ['pending'] }, submittedTxHash: TX_HASH },
        data: expect.objectContaining({ status: 'expired', reviewReason: 'quote_expired' }),
      });
    });

    it('marks the attempt expired when the transfer was mined after the quote expired', async () => {
      getTransactionReceipt.mockResolvedValue(
        receipt({ blockTimestamp: 1_800_000_000n }), // after quoteExpiresAt
      );

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('expired');
      expect(attemptUpdateMany).toHaveBeenCalledWith({
        where: { id: 'att-usdc', status: { in: ['pending'] }, submittedTxHash: TX_HASH },
        data: expect.objectContaining({ status: 'expired' }),
      });
    });

    it('keeps a confirming attempt confirming when the receipt temporarily disappears (never expires)', async () => {
      // The quote is already expired, but the attempt is confirming with
      // recorded evidence: a temporarily missing receipt (RPC pruning/error)
      // must never expire it or lose the evidence.
      getTransactionReceipt.mockResolvedValue(null);
      attemptFindUnique.mockResolvedValue(
        usdcAttempt({
          status: 'confirming',
          txHash: TX_HASH,
          quoteExpiresAt: new Date(Date.now() - 1000),
        }),
      );

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('confirming');
      expect(result.retryable).toBe(true);
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ submittedTxHash: TX_HASH, nextCheckAt: expect.any(Date) }),
        }),
      );
    });

    it('returns a retryable rpc_error for a confirming attempt on a transient RPC error', async () => {
      getTransactionReceipt.mockRejectedValue(new Error('rate limited'));
      attemptFindUnique.mockResolvedValue(usdcAttempt({ status: 'confirming', txHash: TX_HASH }));

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('rpc_error');
      expect(result.retryable).toBe(true);
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ submittedTxHash: TX_HASH, nextCheckAt: expect.any(Date) }),
        }),
      );
    });
  });

  describe('claim — receipt validation', () => {
    beforeEach(() => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice());
      attemptFindUnique.mockResolvedValue(usdcAttempt());
    });

    it('marks the attempt failed when the receipt reverted', async () => {
      getTransactionReceipt.mockResolvedValue(receipt({ status: 'reverted' }));

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('failed');
      expect(attemptUpdateMany).toHaveBeenCalledWith({
        where: { id: 'att-usdc', status: { in: ['pending'] }, submittedTxHash: TX_HASH },
        data: expect.objectContaining({
          status: 'failed',
          failureCode: 'receipt_reverted',
          txHash: TX_HASH,
        }),
      });
    });

    it('marks needs_review when a confirming attempt is reverted (evidence change)', async () => {
      attemptFindUnique.mockResolvedValue(
        usdcAttempt({ status: 'confirming', txHash: TX_HASH, blockHash: BLOCK_HASH }),
      );
      getTransactionReceipt.mockResolvedValue(receipt({ status: 'reverted' }));

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('needs_review');
      expect(result.reviewReason).toBe('reorged');
      expect(attemptUpdateMany).toHaveBeenCalledWith({
        where: {
          id: 'att-usdc',
          status: { in: ['pending', 'confirming'] },
          OR: [{ txHash: null }, { txHash: TX_HASH }],
          submittedTxHash: TX_HASH,
        },
        data: expect.objectContaining({ status: 'needs_review', reviewReason: 'reorged' }),
      });
    });

    it('marks needs_review when the transfer was mined before the attempt was created (replay)', async () => {
      // The attempt was created at 2026-06-01T00:00:00Z (epoch second
      // 1780272000); a receipt mined one second earlier is an old exact
      // transfer that must never settle a newer quote.
      getTransactionReceipt.mockResolvedValue(receipt({ blockTimestamp: 1_780_271_999n }));

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('needs_review');
      expect(result.reviewReason).toBe('receipt_predates_attempt');
      expect(settleInvoice).not.toHaveBeenCalled();
      expect(attemptUpdateMany).toHaveBeenCalledWith({
        where: {
          id: 'att-usdc',
          status: { in: ['pending', 'confirming'] },
          OR: [{ txHash: null }, { txHash: TX_HASH }],
          submittedTxHash: TX_HASH,
        },
        data: expect.objectContaining({
          status: 'needs_review',
          reviewReason: 'receipt_predates_attempt',
          blockTimestamp: 1_780_271_999n,
        }),
      });
    });

    it('marks needs_review when the receipt has no block timestamp', async () => {
      getTransactionReceipt.mockResolvedValue(
        receipt({ blockTimestamp: undefined as unknown as bigint }),
      );

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('needs_review');
      expect(result.reviewReason).toBe('missing_block_timestamp');
      expect(settleInvoice).not.toHaveBeenCalled();
    });

    it('marks needs_review on a receipt hash mismatch', async () => {
      getTransactionReceipt.mockResolvedValue(receipt({ transactionHash: '0x' + 'c'.repeat(64) }));

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('needs_review');
      expect(result.reviewReason).toBe('receipt_hash_mismatch');
    });

    it('marks needs_review on a reorg (block hash changed)', async () => {
      attemptFindUnique.mockResolvedValue(
        usdcAttempt({ status: 'confirming', txHash: TX_HASH, blockHash: '0x' + 'd'.repeat(64) }),
      );
      getTransactionReceipt.mockResolvedValue(receipt());

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('needs_review');
      expect(result.reviewReason).toBe('reorged');
    });

    it('classifies a reorg before expiry when a confirming receipt changes block', async () => {
      // The confirming attempt recorded evidence in block 0xd…; the new
      // receipt is in a different block AND mined after the quote expired.
      // Reorg classification must win over expiry — never expire evidence.
      attemptFindUnique.mockResolvedValue(
        usdcAttempt({
          status: 'confirming',
          txHash: TX_HASH,
          blockHash: '0x' + 'd'.repeat(64),
          blockNumber: 100n,
        }),
      );
      getTransactionReceipt.mockResolvedValue(
        receipt({ blockHash: '0x' + 'b'.repeat(64), blockTimestamp: 1_800_000_000n }),
      );

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('needs_review');
      expect(result.reviewReason).toBe('reorged');
      expect(attemptUpdateMany).toHaveBeenCalledWith({
        where: {
          id: 'att-usdc',
          status: { in: ['pending', 'confirming'] },
          OR: [{ txHash: null }, { txHash: TX_HASH }],
          submittedTxHash: TX_HASH,
        },
        data: expect.objectContaining({ status: 'needs_review', reviewReason: 'reorged' }),
      });
    });

    it('marks needs_review when a confirming attempt evidence changes (log index)', async () => {
      attemptFindUnique.mockResolvedValue(
        usdcAttempt({
          status: 'confirming',
          txHash: TX_HASH,
          logIndex: 0,
          payerAddress: PAYER,
          actualBaseUnits: AMOUNT,
          blockNumber: 100n,
          blockHash: BLOCK_HASH,
        }),
      );
      getTransactionReceipt.mockResolvedValue(receipt({ logs: [transferLog({ logIndex: 1 })] }));

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('needs_review');
      expect(result.reviewReason).toBe('evidence_changed');
    });

    it('returns the owner\'s state untouched on an evidence conflict (different claimed hash)', async () => {
      // A confirming attempt is bound to recorded evidence 0xe…; the user
      // claims a different hash. The losing request must not mark review on
      // the owner's attempt, must not call RPC, and must not mutate anything.
      attemptFindUnique.mockResolvedValue(
        usdcAttempt({ status: 'confirming', txHash: '0x' + 'e'.repeat(64) }),
      );

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('confirming');
      expect(attemptUpdateMany).not.toHaveBeenCalled();
      expect(getTransactionReceipt).not.toHaveBeenCalled();
    });
  });

  describe('claim — strict Transfer matching', () => {
    beforeEach(() => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice());
      attemptFindUnique.mockResolvedValue(usdcAttempt());
      getBlockNumber.mockResolvedValue(104n); // 5 confirmations
    });

    it('marks needs_review when no canonical Transfer log exists', async () => {
      getTransactionReceipt.mockResolvedValue(receipt({ logs: [] }));

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('needs_review');
      expect(result.reviewReason).toBe('no_transfer_log');
    });

    it('marks needs_review when the transfer is from a non-canonical token', async () => {
      getTransactionReceipt.mockResolvedValue(
        receipt({ logs: [transferLog({ token: '0x' + 'f'.repeat(40) })] }),
      );

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('needs_review');
      expect(result.reviewReason).toBe('no_transfer_log');
    });

    it('marks needs_review when the payer is not the expected wallet', async () => {
      getTransactionReceipt.mockResolvedValue(
        receipt({ logs: [transferLog({ from: '0x' + '9'.repeat(40) })] }),
      );

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('needs_review');
      expect(result.reviewReason).toBe('wrong_payer');
    });

    it('marks needs_review when the recipient is not the treasury', async () => {
      getTransactionReceipt.mockResolvedValue(
        receipt({ logs: [transferLog({ to: '0x' + '8'.repeat(40) })] }),
      );

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('needs_review');
      expect(result.reviewReason).toBe('wrong_recipient');
    });

    it('marks needs_review on underpayment', async () => {
      getTransactionReceipt.mockResolvedValue(
        receipt({ logs: [transferLog({ amount: 48_000_000n })] }),
      );

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('needs_review');
      expect(result.reviewReason).toBe('wrong_amount');
    });

    it('marks needs_review on overpayment', async () => {
      getTransactionReceipt.mockResolvedValue(
        receipt({ logs: [transferLog({ amount: 50_000_000n })] }),
      );

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('needs_review');
      expect(result.reviewReason).toBe('wrong_amount');
    });

    it('marks needs_review on malformed topics/data', async () => {
      getTransactionReceipt.mockResolvedValue(
        receipt({
          logs: [
            {
              address: TOKEN_8453,
              topics: [USDC_TRANSFER_TOPIC0, '0x1234'], // not 32 bytes
              data: '0x' + AMOUNT.toString(16).padStart(64, '0'),
              logIndex: 0,
              removed: false,
            },
          ],
        }),
      );

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('needs_review');
      expect(result.reviewReason).toBe('malformed_transfer_log');
    });

    it('marks needs_review on non-zero-padded indexed address topics', async () => {
      getTransactionReceipt.mockResolvedValue(
        receipt({
          logs: [
            {
              address: TOKEN_8453,
              topics: [
                USDC_TRANSFER_TOPIC0,
                '0x' + '1'.repeat(24) + PAYER.slice(2), // non-zero padding
                '0x' + '0'.repeat(24) + TREASURY_8453.slice(2),
              ],
              data: '0x' + AMOUNT.toString(16).padStart(64, '0'),
              logIndex: 0,
              removed: false,
            },
          ],
        }),
      );

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('needs_review');
      expect(result.reviewReason).toBe('malformed_transfer_log');
    });

    it('marks needs_review when only a removed log exists', async () => {
      getTransactionReceipt.mockResolvedValue(receipt({ logs: [transferLog({ removed: true })] }));

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('needs_review');
      expect(result.reviewReason).toBe('removed_log');
    });

    it('rejects a removed log that coexists with an active exact match', async () => {
      getTransactionReceipt.mockResolvedValue(
        receipt({
          logs: [transferLog({ logIndex: 0 }), transferLog({ logIndex: 1, removed: true })],
        }),
      );

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('needs_review');
      expect(result.reviewReason).toBe('removed_log');
      expect(settleInvoice).not.toHaveBeenCalled();
    });

    it('rejects a log with a missing removal flag even alongside an active exact match', async () => {
      getTransactionReceipt.mockResolvedValue(
        receipt({
          logs: [
            transferLog({ logIndex: 0 }),
            { ...transferLog({ logIndex: 1 }), removed: undefined },
          ],
        }),
      );

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('needs_review');
      expect(result.reviewReason).toBe('removed_log');
      expect(settleInvoice).not.toHaveBeenCalled();
    });

    it('marks needs_review on multiple matching transfers', async () => {
      getTransactionReceipt.mockResolvedValue(
        receipt({ logs: [transferLog({ logIndex: 0 }), transferLog({ logIndex: 1 })] }),
      );

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('needs_review');
      expect(result.reviewReason).toBe('ambiguous_transfer');
    });

    it('does not require receipt.to to equal the token contract', async () => {
      // The transfer may be relayed by a smart-contract wallet; only the
      // canonical Transfer log matters.
      getTransactionReceipt.mockResolvedValue(
        receipt({ to: '0x' + '7'.repeat(40), logs: [transferLog()] }),
      );
      settleInvoice.mockResolvedValue({ settled: true });

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('succeeded');
    });
  });

  describe('claim — confirmations and settlement', () => {
    beforeEach(() => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice());
      attemptFindUnique.mockResolvedValue(usdcAttempt());
      getTransactionReceipt.mockResolvedValue(receipt());
    });

    it('records confirming evidence below the confirmation threshold', async () => {
      getBlockNumber.mockResolvedValue(103n); // 4 confirmations

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('confirming');
      expect(result.confirmations).toBe(4);
      expect(result.retryable).toBe(true);
      expect(attemptUpdateMany).toHaveBeenCalledWith({
        where: {
          id: 'att-usdc',
          status: { in: ['pending', 'confirming'] },
          OR: [
            { txHash: null },
            {
              txHash: TX_HASH,
              blockNumber: 100n,
              blockHash: BLOCK_HASH,
              logIndex: 0,
              payerAddress: PAYER,
              actualBaseUnits: AMOUNT,
            },
          ],
          submittedTxHash: TX_HASH,
        },
        data: expect.objectContaining({
          status: 'confirming',
          txHash: TX_HASH,
          logIndex: 0,
          payerAddress: PAYER,
          actualBaseUnits: AMOUNT,
          blockNumber: 100n,
          blockHash: BLOCK_HASH,
          blockTimestamp: 1_785_000_000n,
        }),
      });
      expect(settleInvoice).not.toHaveBeenCalled();
    });

    it('returns a retryable rpc_error when the chain head is behind the receipt block', async () => {
      getBlockNumber.mockResolvedValue(99n); // currentBlock < receipt.blockNumber

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('rpc_error');
      expect(result.retryable).toBe(true);
      expect(settleInvoice).not.toHaveBeenCalled();
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ submittedTxHash: TX_HASH, nextCheckAt: expect.any(Date) }),
        }),
      );
    });

    it('settles a fully confirmed exact transfer through the shared boundary', async () => {
      getBlockNumber.mockResolvedValue(104n); // 5 confirmations
      settleInvoice.mockResolvedValue({ settled: true });

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('succeeded');
      expect(result.paid).toBe(true);
      expect(result.confirmations).toBe(5);
      expect(txAttemptUpdate).toHaveBeenCalledWith({
        where: { id: 'att-usdc' },
        data: expect.objectContaining({
          status: 'succeeded',
          succeededAt: expect.any(Date),
          txHash: TX_HASH,
          logIndex: 0,
          payerAddress: PAYER,
          actualBaseUnits: AMOUNT,
          blockNumber: 100n,
          blockHash: BLOCK_HASH,
          blockTimestamp: 1_785_000_000n,
        }),
      });
      expect(settleInvoice).toHaveBeenCalledWith(tx, {
        id: 'att-usdc',
        invoiceId: 'inv-1',
        method: 'usdc',
      });
    });

    it('canonicalizes the claimed txHash to lowercase for lookup, evidence, and persistence', async () => {
      const upperHash = '0x' + 'A'.repeat(64); // uppercase hex digits, same tx
      getBlockNumber.mockResolvedValue(104n);
      settleInvoice.mockResolvedValue({ settled: true });

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: upperHash,
      });

      expect(result.status).toBe('succeeded');
      expect(result.txHash).toBe(TX_HASH); // canonical lowercase
      expect(getTransactionReceipt).toHaveBeenCalledWith(8453, TX_HASH);
      expect(txAttemptUpdate).toHaveBeenCalledWith({
        where: { id: 'att-usdc' },
        data: expect.objectContaining({ txHash: TX_HASH }),
      });
    });

    it('allows a transfer mined in the same second as the attempt creation (second-granularity lower bound)', async () => {
      // The attempt was created at 2026-06-01T00:00:00.000Z (epoch second
      // 1780272000). A transfer mined in that same second is legitimate — the
      // lower-bound comparison must not falsely flag it as a replay.
      getTransactionReceipt.mockResolvedValue(receipt({ blockTimestamp: 1_780_272_000n }));
      getBlockNumber.mockResolvedValue(104n);
      settleInvoice.mockResolvedValue({ settled: true });

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('succeeded');
      expect(result.paid).toBe(true);
      expect(settleInvoice).toHaveBeenCalled();
    });

    it('marks duplicate_unallocated when another rail already settled the invoice', async () => {
      getBlockNumber.mockResolvedValue(104n);
      settleInvoice.mockResolvedValue({ settled: false });
      txInvoiceFindUnique.mockResolvedValue({ settlementAttemptId: 'att-stripe' });

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('needs_review');
      expect(result.reviewReason).toBe('duplicate_unallocated');
      expect(txAttemptUpdate).toHaveBeenLastCalledWith({
        where: { id: 'att-usdc' },
        data: expect.objectContaining({
          status: 'needs_review',
          reviewReason: 'duplicate_unallocated',
        }),
      });
    });

    it('treats a replay of its own settlement as paid', async () => {
      getBlockNumber.mockResolvedValue(104n);
      settleInvoice.mockResolvedValue({ settled: false });
      txInvoiceFindUnique.mockResolvedValue({ settlementAttemptId: 'att-usdc' });

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('succeeded');
      expect(result.paid).toBe(true);
    });

    it('treats a settlement replay as paid when the attempt is already succeeded under the lock', async () => {
      // A concurrent claim settled while this claim was doing RPC work: the
      // settlement transaction re-reads the attempt under the row lock, sees
      // succeeded + this attempt's pointer, and returns paid without writing.
      getBlockNumber.mockResolvedValue(104n);
      txAttemptFindUnique.mockResolvedValue(
        usdcAttempt({ status: 'succeeded', succeededAt: new Date() }),
      );
      txInvoiceFindUnique.mockResolvedValue({ settlementAttemptId: 'att-usdc' });

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('succeeded');
      expect(result.paid).toBe(true);
      expect(txAttemptUpdate).not.toHaveBeenCalled();
      expect(settleInvoice).not.toHaveBeenCalled();
    });

    it('returns the terminal state when a concurrent claim already marked the attempt for review', async () => {
      getBlockNumber.mockResolvedValue(104n);
      txAttemptFindUnique.mockResolvedValue(
        usdcAttempt({ status: 'needs_review', reviewReason: 'wrong_amount' }),
      );

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('needs_review');
      expect(result.reviewReason).toBe('wrong_amount');
      expect(txAttemptUpdate).not.toHaveBeenCalled();
      expect(settleInvoice).not.toHaveBeenCalled();
    });

    it('marks duplicate_unallocated when the Transfer evidence is already allocated', async () => {
      getBlockNumber.mockResolvedValue(103n); // confirming path
      // persistSubmittedHash succeeds first; the confirming evidence CAS then
      // hits the unique-evidence conflict.
      attemptUpdateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockRejectedValueOnce(p2002());

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('needs_review');
      expect(result.reviewReason).toBe('duplicate_unallocated');
      expect(attemptUpdateMany).toHaveBeenLastCalledWith({
        where: {
          id: 'att-usdc',
          status: { in: ['pending', 'confirming'] },
          OR: [{ txHash: null }, { txHash: TX_HASH }],
          submittedTxHash: TX_HASH,
        },
        data: expect.objectContaining({
          status: 'needs_review',
          reviewReason: 'duplicate_unallocated',
        }),
      });
    });

    it('marks duplicate_unallocated when the same evidence is claimed with different casing', async () => {
      // The service canonicalizes the claimed hash to lowercase before the
      // evidence write; the DB unique index then rejects the duplicate.
      getBlockNumber.mockResolvedValue(103n); // confirming path
      attemptUpdateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockRejectedValueOnce(p2002());

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: '0x' + 'A'.repeat(64), // uppercase form of TX_HASH
      });

      expect(result.status).toBe('needs_review');
      expect(result.reviewReason).toBe('duplicate_unallocated');
    });

    it('marks duplicate_unallocated when the settlement transaction hits a unique conflict', async () => {
      getBlockNumber.mockResolvedValue(104n);
      prisma.$transaction.mockRejectedValueOnce(p2002());

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('needs_review');
      expect(result.reviewReason).toBe('duplicate_unallocated');
      expect(attemptUpdateMany).toHaveBeenCalledWith({
        where: {
          id: 'att-usdc',
          status: { in: ['pending', 'confirming'] },
          OR: [
            { txHash: null },
            {
              txHash: TX_HASH,
              blockNumber: 100n,
              blockHash: BLOCK_HASH,
              logIndex: 0,
              payerAddress: PAYER,
              actualBaseUnits: AMOUNT,
            },
          ],
          submittedTxHash: TX_HASH,
        },
        data: expect.objectContaining({
          status: 'needs_review',
          reviewReason: 'duplicate_unallocated',
        }),
      });
    });

    it('transitions confirming → settled on a later re-claim once confirmations are reached', async () => {
      // First claim: 4 confirmations → confirming.
      getBlockNumber.mockResolvedValue(103n);
      const first = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });
      expect(first.status).toBe('confirming');

      // Re-claim: the attempt is now confirming with recorded evidence; the
      // chain head advanced to 5 confirmations → settle.
      attemptFindUnique.mockResolvedValue(
        usdcAttempt({
          status: 'confirming',
          txHash: TX_HASH,
          logIndex: 0,
          payerAddress: PAYER,
          actualBaseUnits: AMOUNT,
          blockNumber: 100n,
          blockHash: BLOCK_HASH,
          blockTimestamp: 1_700_000_000n,
        }),
      );
      getBlockNumber.mockResolvedValue(104n);
      settleInvoice.mockResolvedValue({ settled: true });

      const second = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(second.status).toBe('succeeded');
      expect(second.paid).toBe(true);
      expect(settleInvoice).toHaveBeenCalledWith(tx, {
        id: 'att-usdc',
        invoiceId: 'inv-1',
        method: 'usdc',
      });
    });

    it('never exposes logs, calldata, RPC details, or secrets in the claim result', async () => {
      getBlockNumber.mockResolvedValue(104n);
      settleInvoice.mockResolvedValue({ settled: true });

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      const keys = Object.keys(result);
      expect(keys).not.toContain('logs');
      expect(keys).not.toContain('calldata');
      expect(keys).not.toContain('rpcUrl');
      expect(keys).not.toContain('openfortAccountId');
      expect(keys).not.toContain('secret');
      expect(JSON.stringify(result)).not.toContain('https://');
    });
  });

  describe('claim — compare-and-set concurrency', () => {
    beforeEach(() => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice());
      attemptFindUnique.mockResolvedValue(usdcAttempt());
    });

    it('returns the real state when a stale confirming CAS loses to a concurrent settlement', async () => {
      // The claim read the attempt as pending, but a concurrent claim settled
      // it while this claim was doing RPC work. The confirming CAS must match
      // zero rows and the current succeeded state must be returned — never an
      // overwrite of the succeeded attempt.
      getTransactionReceipt.mockResolvedValue(receipt());
      getBlockNumber.mockResolvedValue(103n); // confirming path
      attemptUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });
      attemptFindUnique
        .mockResolvedValueOnce(usdcAttempt())
        .mockResolvedValue(usdcAttempt({ status: 'succeeded', succeededAt: new Date() }));
      invoiceFindFirst.mockResolvedValue(invoice({ paidAt: new Date() }));

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('succeeded');
      expect(result.paid).toBe(true);
      expect(attemptUpdateMany).toHaveBeenCalledWith({
        where: {
          id: 'att-usdc',
          status: { in: ['pending', 'confirming'] },
          OR: [
            { txHash: null },
            {
              txHash: TX_HASH,
              blockNumber: 100n,
              blockHash: BLOCK_HASH,
              logIndex: 0,
              payerAddress: PAYER,
              actualBaseUnits: AMOUNT,
            },
          ],
          submittedTxHash: TX_HASH,
        },
        data: expect.objectContaining({ status: 'confirming' }),
      });
    });

    it('returns the real state when a stale expired CAS loses to a concurrent settlement', async () => {
      // The claim read a pending attempt with an expired quote; a concurrent
      // claim settled it before this claim's expiry CAS ran. The expiry CAS
      // (pending-only) must match zero rows and the succeeded state returned.
      getTransactionReceipt.mockResolvedValue(null);
      attemptFindUnique
        .mockResolvedValueOnce(usdcAttempt({ quoteExpiresAt: new Date(Date.now() - 1000) }))
        .mockResolvedValue(usdcAttempt({ status: 'succeeded', succeededAt: new Date() }));
      attemptUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });
      invoiceFindFirst.mockResolvedValue(invoice({ paidAt: new Date() }));

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('succeeded');
      expect(result.paid).toBe(true);
      expect(attemptUpdateMany).toHaveBeenCalledWith({
        where: { id: 'att-usdc', status: { in: ['pending'] }, submittedTxHash: TX_HASH },
        data: expect.objectContaining({ status: 'expired' }),
      });
    });

    it('returns the real state when a stale review CAS loses to a concurrent settlement', async () => {
      // The claim read pending and found a mismatch (no transfer log); a
      // concurrent claim settled the invoice before the review CAS ran. The
      // review CAS must match zero rows and the succeeded state returned.
      getTransactionReceipt.mockResolvedValue(receipt({ logs: [] }));
      attemptUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });
      attemptFindUnique
        .mockResolvedValueOnce(usdcAttempt())
        .mockResolvedValue(usdcAttempt({ status: 'succeeded', succeededAt: new Date() }));
      invoiceFindFirst.mockResolvedValue(invoice({ paidAt: new Date() }));

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('succeeded');
      expect(result.paid).toBe(true);
      expect(attemptUpdateMany).toHaveBeenCalledWith({
        where: {
          id: 'att-usdc',
          status: { in: ['pending', 'confirming'] },
          OR: [{ txHash: null }, { txHash: TX_HASH }],
          submittedTxHash: TX_HASH,
        },
        data: expect.objectContaining({ status: 'needs_review' }),
      });
    });

    it('returns the real state when a stale failed CAS loses to a concurrent settlement', async () => {
      // The claim read pending and saw a reverted receipt; a concurrent claim
      // settled before the failed CAS ran. The failed CAS (pending-only) must
      // match zero rows and the succeeded state returned.
      getTransactionReceipt.mockResolvedValue(receipt({ status: 'reverted' }));
      attemptUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });
      attemptFindUnique
        .mockResolvedValueOnce(usdcAttempt())
        .mockResolvedValue(usdcAttempt({ status: 'succeeded', succeededAt: new Date() }));
      invoiceFindFirst.mockResolvedValue(invoice({ paidAt: new Date() }));

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('succeeded');
      expect(result.paid).toBe(true);
      expect(attemptUpdateMany).toHaveBeenCalledWith({
        where: { id: 'att-usdc', status: { in: ['pending'] }, submittedTxHash: TX_HASH },
        data: expect.objectContaining({ status: 'failed' }),
      });
    });

    it('returns the owner\'s pre-read state when a different claimed hash conflicts (no review write)', async () => {
      // The claim read a confirming attempt bound to hash 0xe… and the user
      // claimed a different hash. The losing request returns the owner's
      // current state without any review CAS and without RPC.
      attemptFindUnique
        .mockResolvedValueOnce(usdcAttempt({ status: 'confirming', txHash: '0x' + 'e'.repeat(64) }))
        .mockResolvedValue(usdcAttempt({ status: 'succeeded', succeededAt: new Date() }));
      attemptUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });
      invoiceFindFirst.mockResolvedValue(invoice({ paidAt: new Date() }));

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('confirming');
      expect(attemptUpdateMany).not.toHaveBeenCalled();
      expect(getTransactionReceipt).not.toHaveBeenCalled();
    });

    it('records a second claim with different evidence as duplicate_unallocated without overwriting the recorded evidence', async () => {
      // Claim A confirmed with evidence 0xe… while this claim was doing RPC
      // work. This claim observed evidence TX_HASH (a different valid hash):
      // its confirming CAS must match zero rows (different evidence identity)
      // and the ambiguity is recorded as duplicate_unallocated review,
      // preserving evidence 0xe….
      getTransactionReceipt.mockResolvedValue(receipt());
      getBlockNumber.mockResolvedValue(103n); // confirming path
      attemptUpdateMany
        .mockResolvedValueOnce({ count: 1 }) // persistSubmittedHash succeeds
        .mockResolvedValueOnce({ count: 0 }) // confirming CAS fails (different evidence)
        .mockResolvedValue({ count: 1 }); // duplicate_unallocated marking succeeds
      attemptFindUnique.mockResolvedValueOnce(usdcAttempt()).mockResolvedValue(
        usdcAttempt({
          status: 'confirming',
          txHash: '0x' + 'e'.repeat(64),
          logIndex: 0,
          payerAddress: PAYER,
          actualBaseUnits: AMOUNT,
          blockNumber: 100n,
          blockHash: '0x' + 'f'.repeat(64),
        }),
      );

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('needs_review');
      expect(result.reviewReason).toBe('duplicate_unallocated');
      // The recorded evidence (0xe…) is preserved: the marking write only sets
      // status/reviewReason, never the evidence columns, and is bound to this
      // claim's canonical submitted hash.
      expect(attemptUpdateMany).toHaveBeenLastCalledWith({
        where: {
          id: 'att-usdc',
          status: { in: ['pending', 'confirming'] },
          submittedTxHash: TX_HASH,
        },
        data: expect.objectContaining({
          status: 'needs_review',
          reviewReason: 'duplicate_unallocated',
        }),
      });
    });

    it('treats a confirming replay with the same evidence as an idempotent confirming result', async () => {
      // The attempt is already confirming with this claim's exact evidence: the
      // evidence-aware CAS matches and re-confirms idempotently — never a
      // duplicate_unallocated review.
      attemptFindUnique.mockResolvedValue(
        usdcAttempt({
          status: 'confirming',
          txHash: TX_HASH,
          logIndex: 0,
          payerAddress: PAYER,
          actualBaseUnits: AMOUNT,
          blockNumber: 100n,
          blockHash: BLOCK_HASH,
        }),
      );
      getTransactionReceipt.mockResolvedValue(receipt());
      getBlockNumber.mockResolvedValue(103n);

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('confirming');
      expect(result.retryable).toBe(true);
      expect(attemptUpdateMany).toHaveBeenCalledWith({
        where: {
          id: 'att-usdc',
          status: { in: ['pending', 'confirming'] },
          OR: [
            { txHash: null },
            {
              txHash: TX_HASH,
              blockNumber: 100n,
              blockHash: BLOCK_HASH,
              logIndex: 0,
              payerAddress: PAYER,
              actualBaseUnits: AMOUNT,
            },
          ],
          submittedTxHash: TX_HASH,
        },
        data: expect.objectContaining({ status: 'confirming' }),
      });
    });

    it('never settles with a different evidence identity recorded under the lock', async () => {
      // This claim read pending and observed evidence TX_HASH; a concurrent
      // claim confirmed evidence 0xe… before this claim's settlement
      // transaction ran. The locked re-read must refuse to write/settle with
      // TX_HASH and record the ambiguity as duplicate_unallocated review,
      // preserving evidence 0xe….
      getTransactionReceipt.mockResolvedValue(receipt());
      getBlockNumber.mockResolvedValue(104n); // settle path
      txAttemptFindUnique.mockResolvedValue(
        usdcAttempt({
          status: 'confirming',
          txHash: '0x' + 'e'.repeat(64),
          logIndex: 0,
          payerAddress: PAYER,
          actualBaseUnits: AMOUNT,
          blockNumber: 100n,
          blockHash: '0x' + 'f'.repeat(64),
        }),
      );

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('needs_review');
      expect(result.reviewReason).toBe('duplicate_unallocated');
      expect(settleInvoice).not.toHaveBeenCalled();
      expect(txAttemptUpdate).toHaveBeenCalledWith({
        where: { id: 'att-usdc' },
        data: expect.objectContaining({
          status: 'needs_review',
          reviewReason: 'duplicate_unallocated',
        }),
      });
    });

    it('never lets a stale review write overwrite a confirming attempt bound to different evidence', async () => {
      // The claim read pending and found a wrong-amount mismatch for TX_HASH;
      // a concurrent claim confirmed evidence 0xe… before the review CAS ran.
      // The review CAS (bound to the claimed hash) must match zero rows and the
      // real confirming state returned — never an overwrite of the recorded
      // evidence.
      getTransactionReceipt.mockResolvedValue(
        receipt({ logs: [transferLog({ amount: 48_000_000n })] }),
      );
      attemptUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });
      attemptFindUnique.mockResolvedValueOnce(usdcAttempt()).mockResolvedValue(
        usdcAttempt({
          status: 'confirming',
          txHash: '0x' + 'e'.repeat(64),
          logIndex: 0,
          payerAddress: PAYER,
          actualBaseUnits: AMOUNT,
          blockNumber: 100n,
          blockHash: '0x' + 'f'.repeat(64),
        }),
      );

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH,
      });

      expect(result.status).toBe('confirming');
      expect(result.retryable).toBe(true);
      // The review CAS was bound to the claimed hash and matched zero rows.
      expect(attemptUpdateMany).toHaveBeenCalledWith({
        where: {
          id: 'att-usdc',
          status: { in: ['pending', 'confirming'] },
          OR: [{ txHash: null }, { txHash: TX_HASH }],
          submittedTxHash: TX_HASH,
        },
        data: expect.objectContaining({ status: 'needs_review', reviewReason: 'wrong_amount' }),
      });
    });
  });

  describe('claim — submitted hash persistence (Phase 1 worker foundation)', () => {
    const TX_HASH2 = '0x' + '9'.repeat(64);

    beforeEach(() => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice());
      attemptFindUnique.mockResolvedValue(usdcAttempt());
    });

    it('persists the canonical submitted hash before verification so a restart can resume the claim', async () => {
      getTransactionReceipt.mockResolvedValue(null); // receipt not found yet

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: '0x' + 'A'.repeat(64), // uppercase input is canonicalized to lowercase
      });

      expect(result.status).toBe('pending');
      expect(result.retryable).toBe(true);
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'att-usdc',
            status: { in: ['pending', 'confirming'] },
            OR: [{ submittedTxHash: null }, { submittedTxHash: TX_HASH }],
          }),
          data: expect.objectContaining({
            submittedTxHash: TX_HASH,
            nextCheckAt: expect.any(Date),
          }),
        }),
      );
    });

    it('never lets a competing submitted hash overwrite the recorded hash or do provider work', async () => {
      // A first claim recorded submittedTxHash = TX_HASH (persist CAS matched the
      // null guard). A competing claim with a DIFFERENT hash must match zero rows
      // (the OR guard fails) and must not rewrite the recorded hash.
      attemptFindUnique.mockResolvedValue(usdcAttempt({ submittedTxHash: TX_HASH }));
      attemptUpdateMany.mockResolvedValue({ count: 0 }); // persist CAS matches nothing
      getTransactionReceipt.mockClear();

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH2,
      });

      // The competing hash is not persisted, no RPC is performed, and the
      // owner's attempt is returned untouched (pending, retryable).
      expect(result.status).toBe('pending');
      expect(result.retryable).toBe(true);
      expect(getTransactionReceipt).not.toHaveBeenCalled();
      expect(attemptUpdateMany).toHaveBeenCalledTimes(1); // only the persist CAS
      const persistCall = attemptUpdateMany.mock.calls.find(
        ([arg]) =>
          arg?.data &&
          typeof arg.data === 'object' &&
          'submittedTxHash' in (arg.data as Record<string, unknown>),
      );
      expect(persistCall).toBeDefined();
      expect((persistCall![0] as { where: Record<string, unknown> }).where).toEqual(
        expect.objectContaining({
          OR: [{ submittedTxHash: null }, { submittedTxHash: TX_HASH2 }],
        }),
      );
    });

    it('a losing claim can never expire, review, or bind evidence on the winner\'s attempt', async () => {
      // The winner owns submittedTxHash = TX_HASH on a pending attempt whose
      // quote window has expired. The loser claims TX_HASH2: the persist CAS
      // matches zero rows, so the loser can neither expire the winner (its
      // expiry CAS is never reached) nor bind/overwrite evidence.
      attemptFindUnique.mockResolvedValue(
        usdcAttempt({
          status: 'pending',
          submittedTxHash: TX_HASH,
          txHash: null,
          quoteExpiresAt: new Date(Date.now() - 1000),
        }),
      );
      attemptUpdateMany.mockResolvedValue({ count: 0 }); // persist CAS fails
      getTransactionReceipt.mockClear();

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH2,
      });

      expect(result.status).toBe('pending');
      expect(getTransactionReceipt).not.toHaveBeenCalled();
      // Only the failed persist CAS ran — never an expiry/review/evidence write.
      expect(attemptUpdateMany).toHaveBeenCalledTimes(1);
      expect(
        attemptUpdateMany.mock.calls.every(
          ([arg]) =>
            !(arg?.data && typeof arg.data === 'object' && 'status' in (arg.data as object)),
        ),
      ).toBe(true);
    });

    it('resumes a pending claim from the persisted submitted hash alone after a restart', async () => {
      // A previous process persisted submittedTxHash = TX_HASH and died before
      // recording evidence. The recovery path (worker) calls claim() with only
      // the stored hash: the persist CAS matches the existing submitted hash,
      // so the claim proceeds to RPC verification using the stored hash.
      attemptFindUnique.mockResolvedValue(usdcAttempt({ submittedTxHash: TX_HASH }));
      getTransactionReceipt.mockResolvedValue(null); // still not mined — retryable

      const result = await service.claim('user-1', 'inv-1', {
        paymentAttemptId: 'att-usdc',
        txHash: TX_HASH, // recovered from the persisted hash, not re-derived
      });

      expect(result.status).toBe('pending');
      expect(result.retryable).toBe(true);
      expect(getTransactionReceipt).toHaveBeenCalledWith(8453, TX_HASH);
    });
  });
});
