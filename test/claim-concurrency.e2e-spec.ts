/**
 * Real-PostgreSQL concurrency integration test for USDC claims.
 *
 * Uses the real DATABASE_URL (docker-compose Postgres) — no mocks for the
 * database. Only the RPC provider is mocked (deterministic receipts); the
 * claim service runs against real Postgres with real row locks and CAS
 * transitions. Creates its own finalized invoices + pending USDC attempts,
 * actually races concurrent `claim()` calls, asserts the invariants (at most
 * one settlement, consistent paidVia/pointer, stale claims cannot regress a
 * succeeded state, normalized tx_hash uniqueness), and cleans up its own data.
 *
 * Runs via `npm run test:e2e` (maxWorkers=1) following the repo convention for
 * DB-dependent tests. Requires a reachable Postgres at DATABASE_URL.
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/core/database/prisma.service';
import { InvoiceSettlementService } from '../src/modules/billing/invoice-settlement.service';
import { UsdcPaymentService } from '../src/modules/billing/onchain/usdc-payment.service';
import { USDC_TRANSFER_TOPIC0 } from '../src/modules/billing/onchain/usdc.constants';
import type {
  UsdcReceipt,
  UsdcReceiptLog,
  UsdcReceiptProvider,
} from '../src/modules/billing/onchain/usdc-receipt.provider';

const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });

const AMOUNT_MICROS = 49_000_000n;
const TREASURY = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // canonical Base USDC
const RPC_URL = 'https://base.example.com/rpc';
const TX_HASH = '0x' + 'a'.repeat(64);
const BLOCK_HASH = '0x' + 'b'.repeat(64);
const PROVIDER_IDENTITY = createHash('sha256').update(RPC_URL).digest('hex');

/** Deterministic unique payer per seed (wallet_address is globally unique). */
function payerFor(userId: string): string {
  return '0x' + createHash('sha256').update(`payer:${userId}`).digest('hex').slice(0, 40);
}

function transferLog(payer: string, overrides: Partial<UsdcReceiptLog> = {}): UsdcReceiptLog {
  return {
    address: TOKEN.toLowerCase(),
    topics: [
      USDC_TRANSFER_TOPIC0,
      '0x' + '0'.repeat(24) + payer.slice(2),
      '0x' + '0'.repeat(24) + TREASURY.slice(2),
    ],
    data: '0x' + AMOUNT_MICROS.toString(16).padStart(64, '0'),
    logIndex: 0,
    removed: false,
    ...overrides,
  };
}

function confirmedReceiptFor(payer: string, overrides: Partial<UsdcReceipt> = {}): UsdcReceipt {
  return {
    status: 'success',
    transactionHash: TX_HASH,
    from: payer,
    to: TOKEN,
    blockNumber: 100n,
    blockHash: BLOCK_HASH,
    // Mined at claim time (after the attempt's createdAt) and before the
    // quote expiry, so the chain-time lower/upper bounds pass.
    blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
    logs: [transferLog(payer)],
    ...overrides,
  };
}

interface SeededUsdcInvoice {
  userId: string;
  accountId: string;
  planId: string;
  invoiceId: string;
  attemptId: string;
  payer: string;
}

async function seedUsdcInvoice(): Promise<SeededUsdcInvoice> {
  const userId = randomUUID();
  const accountId = randomUUID();
  const planId = randomUUID();
  const invoiceId = randomUUID();
  const attemptId = randomUUID();
  const payer = payerFor(userId);
  const periodStart = new Date('2026-07-01T00:00:00.000Z');
  const periodEnd = new Date('2026-08-01T00:00:00.000Z');

  await prisma.user.create({
    data: { id: userId, socialProvider: 'test', socialId: `claim-concurrency-${userId}` },
  });
  await prisma.billingAccount.create({ data: { id: accountId, userId } });
  await prisma.billingPlanVersion.create({
    data: {
      id: planId,
      code: `claim-plan-${userId}`,
      version: 1,
      name: 'Claim Concurrency Test Plan',
      effectiveFrom: periodStart,
    },
  });
  await prisma.billingInvoice.create({
    data: {
      id: invoiceId,
      billingAccountId: accountId,
      planVersionId: planId,
      periodStart,
      periodEnd,
      status: 'finalized',
      currency: 'USD',
      grossOutboundMicros: 0n,
      billableOutboundMicros: 0n,
      apiCalls: 0n,
      activeWallets: 0,
      monthlyFeeMicros: AMOUNT_MICROS,
      outboundOverageMicros: 0n,
      apiOverageMicros: 0n,
      walletOverageMicros: 0n,
      totalMicros: AMOUNT_MICROS,
      snapshotJson: {},
      snapshotHash: 'claim-concurrency-test',
      finalizedAt: new Date(),
    },
  });
  await prisma.userWallet.create({
    data: { userId, walletAddress: payer, status: 'active' },
  });
  await prisma.billingPaymentAttempt.create({
    data: {
      id: attemptId,
      invoiceId,
      method: 'usdc',
      status: 'pending',
      amountMicros: AMOUNT_MICROS,
      currency: 'USD',
      chainId: 8453n,
      tokenAddress: TOKEN,
      treasuryAddress: TREASURY,
      tokenDecimals: 6,
      expectedBaseUnits: AMOUNT_MICROS,
      quoteExpiresAt: new Date(Date.now() + 3600_000),
      priceSource: 'usdc_6decimals',
      expectedPayerAddress: payer,
      requiredConfirmations: 5,
      providerIdentity: PROVIDER_IDENTITY,
    },
  });
  return { userId, accountId, planId, invoiceId, attemptId, payer };
}

/**
 * Seeds a second invoice + pending USDC attempt for the same user (same
 * wallet/payer) with a distinct period, so two attempts can claim the same
 * on-chain evidence tuple without sharing an invoice.
 */
async function seedSecondInvoice(seed: SeededUsdcInvoice): Promise<SeededUsdcInvoice> {
  const invoiceId = randomUUID();
  const attemptId = randomUUID();
  const periodStart = new Date('2026-08-01T00:00:00.000Z');
  const periodEnd = new Date('2026-09-01T00:00:00.000Z');

  await prisma.billingInvoice.create({
    data: {
      id: invoiceId,
      billingAccountId: seed.accountId,
      planVersionId: seed.planId,
      periodStart,
      periodEnd,
      status: 'finalized',
      currency: 'USD',
      grossOutboundMicros: 0n,
      billableOutboundMicros: 0n,
      apiCalls: 0n,
      activeWallets: 0,
      monthlyFeeMicros: AMOUNT_MICROS,
      outboundOverageMicros: 0n,
      apiOverageMicros: 0n,
      walletOverageMicros: 0n,
      totalMicros: AMOUNT_MICROS,
      snapshotJson: {},
      snapshotHash: 'claim-concurrency-test',
      finalizedAt: new Date(),
    },
  });
  await prisma.billingPaymentAttempt.create({
    data: {
      id: attemptId,
      invoiceId,
      method: 'usdc',
      status: 'pending',
      amountMicros: AMOUNT_MICROS,
      currency: 'USD',
      chainId: 8453n,
      tokenAddress: TOKEN,
      treasuryAddress: TREASURY,
      tokenDecimals: 6,
      expectedBaseUnits: AMOUNT_MICROS,
      quoteExpiresAt: new Date(Date.now() + 3600_000),
      priceSource: 'usdc_6decimals',
      expectedPayerAddress: seed.payer,
      requiredConfirmations: 5,
      providerIdentity: PROVIDER_IDENTITY,
    },
  });
  return { ...seed, invoiceId, attemptId };
}

async function cleanup(seed: SeededUsdcInvoice): Promise<void> {
  // A second invoice for the same user shares the account/plan/wallet/user;
  // delete all of the user's billing rows at once, once per user.
  if (cleanedUsers.has(seed.userId)) return;
  cleanedUsers.add(seed.userId);
  const invoiceIds = await prisma.billingInvoice.findMany({
    where: { billingAccountId: seed.accountId },
    select: { id: true },
  });
  await prisma.billingPaymentAttempt.deleteMany({
    where: { invoiceId: { in: invoiceIds.map((i) => i.id) } },
  });
  await prisma.billingInvoice.deleteMany({ where: { billingAccountId: seed.accountId } });
  await prisma.billingPlanVersion.delete({ where: { id: seed.planId } });
  await prisma.billingAccount.delete({ where: { id: seed.accountId } });
  await prisma.userWallet.deleteMany({ where: { userId: seed.userId } });
  await prisma.user.delete({ where: { id: seed.userId } });
}

const cleanedUsers = new Set<string>();

/** Builds the claim service against real Postgres with a mocked RPC provider. */
function buildService(provider: UsdcReceiptProvider): UsdcPaymentService {
  const config = {
    get: (key: string) => {
      const values: Record<string, unknown> = {
        'billing.usdc.enabled': true,
        'billing.usdc.treasuryAddresses.8453': TREASURY,
        'billing.usdc.rpcUrls.8453': RPC_URL,
        'billing.usdc.requiredConfirmations': 5,
        'billing.usdc.quoteTtlSeconds': 86400,
        'chain.defaultChainId': 84532,
      };
      return values[key];
    },
  };
  return new UsdcPaymentService(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
    new InvoiceSettlementService(),
    provider,
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('UsdcPaymentService claim concurrency (real PostgreSQL)', () => {
  const seeds: SeededUsdcInvoice[] = [];

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterEach(async () => {
    for (const seed of seeds.splice(0)) {
      await cleanup(seed);
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('settles at most once when two claims race on the same attempt', async () => {
    const seed = await seedUsdcInvoice();
    seeds.push(seed);
    const provider = {
      getTransactionReceipt: jest.fn(async () => confirmedReceiptFor(seed.payer)),
      getBlockNumber: jest.fn(async () => 104n), // 5 confirmations
    };
    const service = buildService(provider);

    const results = await Promise.all([
      service.claim(seed.userId, seed.invoiceId, {
        paymentAttemptId: seed.attemptId,
        txHash: TX_HASH,
      }),
      service.claim(seed.userId, seed.invoiceId, {
        paymentAttemptId: seed.attemptId,
        txHash: TX_HASH,
      }),
    ]);

    // Both claims observe the settled state (one performs the settlement, the
    // other is an idempotent replay under the row lock) — never two winners.
    expect(results.map((r) => r.status)).toEqual(['succeeded', 'succeeded']);
    expect(results.every((r) => r.paid)).toBe(true);

    const attempt = await prisma.billingPaymentAttempt.findUnique({
      where: { id: seed.attemptId },
    });
    const invoice = await prisma.billingInvoice.findUnique({ where: { id: seed.invoiceId } });
    expect(attempt).not.toBeNull();
    expect(invoice).not.toBeNull();
    expect(attempt!.status).toBe('succeeded');
    expect(attempt!.txHash).toBe(TX_HASH);
    expect(invoice!.paidAt).not.toBeNull();
    expect(invoice!.settlementAttemptId).toBe(seed.attemptId);
    expect(invoice!.paidVia).toBe('usdc');
  });

  it('a stale claim cannot regress a succeeded attempt', async () => {
    const seed = await seedUsdcInvoice();
    seeds.push(seed);

    // Claim A reads the attempt as pending, then blocks inside the RPC call.
    // Claim B settles fully. When claim A is released, its stale read must not
    // regress the succeeded state: its confirming CAS matches zero rows and
    // the real succeeded state is returned.
    let releaseA: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let receiptCalls = 0;
    let blockCalls = 0;
    const provider = {
      getTransactionReceipt: jest.fn(async () => {
        receiptCalls++;
        if (receiptCalls === 1) await gateA; // claim A blocks here
        return confirmedReceiptFor(seed.payer);
      }),
      getBlockNumber: jest.fn(async () => {
        blockCalls++;
        // Claim B (first to reach the head) sees 5 confirmations and settles;
        // claim A (released later) sees 4 confirmations and takes the
        // confirming CAS path, which must lose to the succeeded state.
        return blockCalls === 1 ? 104n : 103n;
      }),
    };
    const service = buildService(provider);

    const claimA = service.claim(seed.userId, seed.invoiceId, {
      paymentAttemptId: seed.attemptId,
      txHash: TX_HASH,
    });
    await waitFor(() => receiptCalls === 1);

    const resultB = await service.claim(seed.userId, seed.invoiceId, {
      paymentAttemptId: seed.attemptId,
      txHash: TX_HASH,
    });
    expect(resultB.status).toBe('succeeded');

    releaseA!();
    const resultA = await claimA;
    expect(resultA.status).toBe('succeeded');
    expect(resultA.paid).toBe(true);

    const attempt = await prisma.billingPaymentAttempt.findUnique({
      where: { id: seed.attemptId },
    });
    const invoice = await prisma.billingInvoice.findUnique({ where: { id: seed.invoiceId } });
    expect(attempt).not.toBeNull();
    expect(invoice).not.toBeNull();
    expect(attempt!.status).toBe('succeeded');
    expect(invoice!.paidAt).not.toBeNull();
    expect(invoice!.settlementAttemptId).toBe(seed.attemptId);
  });

  it('enforces normalized tx_hash uniqueness across attempts (uppercase/lowercase)', async () => {
    const seedA = await seedUsdcInvoice();
    seeds.push(seedA);
    // Second invoice + attempt for the same user (same payer), so the shared
    // receipt matches both attempts and only the evidence tuple collides.
    const seedB = await seedSecondInvoice(seedA);
    seeds.push(seedB);

    const provider = {
      getTransactionReceipt: jest.fn(async () => confirmedReceiptFor(seedA.payer)),
      getBlockNumber: jest.fn(async () => 104n),
    };
    const service = buildService(provider);

    // Claim A with the canonical lowercase hash → settles.
    const resultA = await service.claim(seedA.userId, seedA.invoiceId, {
      paymentAttemptId: seedA.attemptId,
      txHash: TX_HASH,
    });
    expect(resultA.status).toBe('succeeded');

    // Claim B with the same tx in uppercase hex → canonicalized to the same
    // lowercase hash; the DB unique evidence index rejects the duplicate.
    const resultB = await service.claim(seedB.userId, seedB.invoiceId, {
      paymentAttemptId: seedB.attemptId,
      txHash: '0x' + 'A'.repeat(64),
    });
    expect(resultB.status).toBe('needs_review');
    expect(resultB.reviewReason).toBe('duplicate_unallocated');

    const attemptA = await prisma.billingPaymentAttempt.findUnique({
      where: { id: seedA.attemptId },
    });
    const attemptB = await prisma.billingPaymentAttempt.findUnique({
      where: { id: seedB.attemptId },
    });
    const invoiceA = await prisma.billingInvoice.findUnique({ where: { id: seedA.invoiceId } });
    const invoiceB = await prisma.billingInvoice.findUnique({ where: { id: seedB.invoiceId } });
    expect(attemptA).not.toBeNull();
    expect(attemptB).not.toBeNull();
    expect(invoiceA).not.toBeNull();
    expect(invoiceB).not.toBeNull();
    expect(attemptA!.status).toBe('succeeded');
    expect(attemptA!.txHash).toBe(TX_HASH);
    expect(invoiceA!.paidAt).not.toBeNull();
    expect(attemptB!.status).toBe('needs_review');
    expect(attemptB!.reviewReason).toBe('duplicate_unallocated');
    expect(invoiceB!.paidAt).toBeNull();
  });

  it('never lets a second claim overwrite the winner evidence or settle with its own evidence (two different hashes)', async () => {
    const seed = await seedUsdcInvoice();
    seeds.push(seed);
    const txHashA = '0x' + 'a'.repeat(64);
    const txHashB = '0x' + 'b'.repeat(64);
    const blockHashA = '0x' + 'c'.repeat(64);
    const blockHashB = '0x' + 'd'.repeat(64);

    // Both receipts are valid exact transfers from the same payer; only the tx
    // hash / block identity differs.
    const receiptA = confirmedReceiptFor(seed.payer, {
      transactionHash: txHashA,
      blockHash: blockHashA,
    });
    const receiptB = confirmedReceiptFor(seed.payer, {
      transactionHash: txHashB,
      blockHash: blockHashB,
    });

    // Gate claim A inside its RPC call so both claims read the attempt as
    // pending before either writes evidence; claim B settles first.
    let releaseA: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let receiptCalls = 0;
    const provider = {
      getTransactionReceipt: jest.fn(async (_chainId: number, hash: string) => {
        receiptCalls++;
        if (receiptCalls === 1) await gateA;
        return hash === txHashA ? receiptA : receiptB;
      }),
      getBlockNumber: jest.fn(async () => 104n), // 5 confirmations → settle path
    };
    const service = buildService(provider);

    const claimA = service.claim(seed.userId, seed.invoiceId, {
      paymentAttemptId: seed.attemptId,
      txHash: txHashA,
    });
    await waitFor(() => receiptCalls === 1);

    const resultB = await service.claim(seed.userId, seed.invoiceId, {
      paymentAttemptId: seed.attemptId,
      txHash: txHashB,
    });
    releaseA!();
    const resultA = await claimA;

    // Exactly one evidence wins settlement; the stale claim cannot overwrite it
    // and cannot settle with its own evidence.
    const attempt = await prisma.billingPaymentAttempt.findUnique({
      where: { id: seed.attemptId },
    });
    const invoice = await prisma.billingInvoice.findUnique({ where: { id: seed.invoiceId } });
    expect(attempt).not.toBeNull();
    expect(invoice).not.toBeNull();
    expect(attempt!.status).toBe('succeeded');
    expect(attempt!.txHash).toBe(txHashB); // winner evidence preserved
    expect(attempt!.txHash).not.toBe(txHashA); // loser evidence never recorded
    expect(invoice!.paidAt).not.toBeNull();
    expect(invoice!.settlementAttemptId).toBe(seed.attemptId);
    expect(invoice!.paidVia).toBe('usdc');
    // The stale claim observes the real paid state (safe current state).
    expect(resultA.status).toBe('succeeded');
    expect(resultA.paid).toBe(true);
    expect(resultB.status).toBe('succeeded');
    expect(resultB.paid).toBe(true);
  });

  it('records a second claim with different evidence as duplicate_unallocated when both are below the confirmation threshold', async () => {
    const seed = await seedUsdcInvoice();
    seeds.push(seed);
    const txHashA = '0x' + 'a'.repeat(64);
    const txHashB = '0x' + 'b'.repeat(64);

    let releaseA: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let receiptCalls = 0;
    const provider = {
      getTransactionReceipt: jest.fn(async (_chainId: number, hash: string) => {
        receiptCalls++;
        if (receiptCalls === 1) await gateA;
        return hash === txHashA
          ? confirmedReceiptFor(seed.payer, { transactionHash: txHashA })
          : confirmedReceiptFor(seed.payer, { transactionHash: txHashB });
      }),
      getBlockNumber: jest.fn(async () => 103n), // 4 confirmations → confirming path
    };
    const service = buildService(provider);

    const claimA = service.claim(seed.userId, seed.invoiceId, {
      paymentAttemptId: seed.attemptId,
      txHash: txHashA,
    });
    await waitFor(() => receiptCalls === 1);

    // Claim B confirms first with evidence B.
    const resultB = await service.claim(seed.userId, seed.invoiceId, {
      paymentAttemptId: seed.attemptId,
      txHash: txHashB,
    });
    expect(resultB.status).toBe('confirming');

    releaseA!();
    // Claim A's confirming CAS must lose (different evidence identity) and the
    // ambiguity is recorded as duplicate_unallocated review, preserving B.
    const resultA = await claimA;
    expect(resultA.status).toBe('needs_review');
    expect(resultA.reviewReason).toBe('duplicate_unallocated');

    const attempt = await prisma.billingPaymentAttempt.findUnique({
      where: { id: seed.attemptId },
    });
    const invoice = await prisma.billingInvoice.findUnique({ where: { id: seed.invoiceId } });
    expect(attempt).not.toBeNull();
    expect(invoice).not.toBeNull();
    expect(attempt!.status).toBe('needs_review');
    expect(attempt!.reviewReason).toBe('duplicate_unallocated');
    expect(attempt!.txHash).toBe(txHashB); // winner evidence preserved
    expect(attempt!.txHash).not.toBe(txHashA);
    expect(invoice!.paidAt).toBeNull();
  });

  it('a stale claim with a different hash cannot regress a succeeded attempt to confirming', async () => {
    const seed = await seedUsdcInvoice();
    seeds.push(seed);
    const txHashA = '0x' + 'a'.repeat(64);
    const txHashB = '0x' + 'b'.repeat(64);

    let releaseA: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let receiptCalls = 0;
    let blockCalls = 0;
    const provider = {
      getTransactionReceipt: jest.fn(async (_chainId: number, hash: string) => {
        receiptCalls++;
        if (receiptCalls === 1) await gateA;
        return hash === txHashA
          ? confirmedReceiptFor(seed.payer, { transactionHash: txHashA })
          : confirmedReceiptFor(seed.payer, { transactionHash: txHashB });
      }),
      getBlockNumber: jest.fn(async () => {
        blockCalls++;
        // Claim B (first to reach the head) sees 5 confirmations and settles;
        // claim A (released later) sees 4 confirmations and takes the
        // confirming CAS path, which must lose to the succeeded state.
        return blockCalls === 1 ? 104n : 103n;
      }),
    };
    const service = buildService(provider);

    const claimA = service.claim(seed.userId, seed.invoiceId, {
      paymentAttemptId: seed.attemptId,
      txHash: txHashA,
    });
    await waitFor(() => receiptCalls === 1);

    const resultB = await service.claim(seed.userId, seed.invoiceId, {
      paymentAttemptId: seed.attemptId,
      txHash: txHashB,
    });
    expect(resultB.status).toBe('succeeded');

    releaseA!();
    const resultA = await claimA;
    expect(resultA.status).toBe('succeeded');
    expect(resultA.paid).toBe(true);

    const attempt = await prisma.billingPaymentAttempt.findUnique({
      where: { id: seed.attemptId },
    });
    const invoice = await prisma.billingInvoice.findUnique({ where: { id: seed.invoiceId } });
    expect(attempt).not.toBeNull();
    expect(invoice).not.toBeNull();
    expect(attempt!.status).toBe('succeeded');
    expect(attempt!.txHash).toBe(txHashB);
    expect(invoice!.paidAt).not.toBeNull();
    expect(invoice!.settlementAttemptId).toBe(seed.attemptId);
  });

  it('a stale claim with a different hash cannot regress a succeeded attempt to review', async () => {
    const seed = await seedUsdcInvoice();
    seeds.push(seed);
    const txHashA = '0x' + 'a'.repeat(64);
    const txHashB = '0x' + 'b'.repeat(64);

    let releaseA: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let receiptCalls = 0;
    const provider = {
      getTransactionReceipt: jest.fn(async (_chainId: number, hash: string) => {
        receiptCalls++;
        if (receiptCalls === 1) await gateA;
        if (hash === txHashA) {
          // Claim A's receipt has a wrong amount → review path.
          return confirmedReceiptFor(seed.payer, {
            transactionHash: txHashA,
            logs: [
              transferLog(seed.payer, {
                data: '0x' + (AMOUNT_MICROS - 1n).toString(16).padStart(64, '0'),
              }),
            ],
          });
        }
        return confirmedReceiptFor(seed.payer, { transactionHash: txHashB });
      }),
      getBlockNumber: jest.fn(async () => 104n),
    };
    const service = buildService(provider);

    const claimA = service.claim(seed.userId, seed.invoiceId, {
      paymentAttemptId: seed.attemptId,
      txHash: txHashA,
    });
    await waitFor(() => receiptCalls === 1);

    const resultB = await service.claim(seed.userId, seed.invoiceId, {
      paymentAttemptId: seed.attemptId,
      txHash: txHashB,
    });
    expect(resultB.status).toBe('succeeded');

    releaseA!();
    const resultA = await claimA;
    expect(resultA.status).toBe('succeeded');
    expect(resultA.paid).toBe(true);

    const attempt = await prisma.billingPaymentAttempt.findUnique({
      where: { id: seed.attemptId },
    });
    const invoice = await prisma.billingInvoice.findUnique({ where: { id: seed.invoiceId } });
    expect(attempt).not.toBeNull();
    expect(invoice).not.toBeNull();
    expect(attempt!.status).toBe('succeeded');
    expect(attempt!.txHash).toBe(txHashB);
    expect(invoice!.paidAt).not.toBeNull();
    expect(invoice!.settlementAttemptId).toBe(seed.attemptId);
  });

  it('a stale claim with a different hash cannot regress a succeeded attempt to expired', async () => {
    const seed = await seedUsdcInvoice();
    seeds.push(seed);
    // Age the attempt so its quote is already expired while receipt B was mined
    // before the expiry (so B can still settle).
    await prisma.billingPaymentAttempt.update({
      where: { id: seed.attemptId },
      data: {
        createdAt: new Date(Date.now() - 7200_000),
        quoteExpiresAt: new Date(Date.now() - 3600_000),
      },
    });
    const txHashA = '0x' + 'a'.repeat(64);
    const txHashB = '0x' + 'b'.repeat(64);

    let releaseA: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let receiptCalls = 0;
    const provider = {
      getTransactionReceipt: jest.fn(async (_chainId: number, hash: string) => {
        receiptCalls++;
        if (receiptCalls === 1) await gateA;
        if (hash === txHashA) return null; // claim A: receipt not found → expiry path
        return confirmedReceiptFor(seed.payer, {
          transactionHash: txHashB,
          blockTimestamp: BigInt(Math.floor((Date.now() - 5400_000) / 1000)),
        });
      }),
      getBlockNumber: jest.fn(async () => 104n),
    };
    const service = buildService(provider);

    const claimA = service.claim(seed.userId, seed.invoiceId, {
      paymentAttemptId: seed.attemptId,
      txHash: txHashA,
    });
    await waitFor(() => receiptCalls === 1);

    const resultB = await service.claim(seed.userId, seed.invoiceId, {
      paymentAttemptId: seed.attemptId,
      txHash: txHashB,
    });
    expect(resultB.status).toBe('succeeded');

    releaseA!();
    const resultA = await claimA;
    expect(resultA.status).toBe('succeeded');
    expect(resultA.paid).toBe(true);

    const attempt = await prisma.billingPaymentAttempt.findUnique({
      where: { id: seed.attemptId },
    });
    const invoice = await prisma.billingInvoice.findUnique({ where: { id: seed.invoiceId } });
    expect(attempt).not.toBeNull();
    expect(invoice).not.toBeNull();
    expect(attempt!.status).toBe('succeeded');
    expect(attempt!.txHash).toBe(txHashB);
    expect(invoice!.paidAt).not.toBeNull();
    expect(invoice!.settlementAttemptId).toBe(seed.attemptId);
  });
});
