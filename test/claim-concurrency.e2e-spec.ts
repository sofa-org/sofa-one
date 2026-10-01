/**
 * Real-PostgreSQL concurrency integration test for USDC claims.
 *
 * Runner-provisioned BILLING_E2E_* target only (see test/billing-e2e-database.ts
 * + scripts/billing-e2e-runner.ts). Never falls back to inherited DATABASE_URL
 * or a static shared database. Only the RPC provider is mocked; the claim
 * service runs against real Postgres with real row locks and CAS transitions.
 *
 * Run via `npm run test:e2e:billing`.
 */
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
import {
  applyBillingE2eDatabaseUrl,
  assertBillingE2eDatabaseIdentity,
  queryBillingE2eIdentityWithPrisma,
  resolveBillingE2eDatabaseTarget,
} from './billing-e2e-database';

const billingE2eDb = applyBillingE2eDatabaseUrl(resolveBillingE2eDatabaseTarget());
const prisma = new PrismaClient({ adapter: new PrismaPg(billingE2eDb.url) });

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
  // Mark cleaned only after deletes succeed so a failed cleanup can retry.
  if (cleanedUsers.has(seed.userId)) return;
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
  cleanedUsers.add(seed.userId);
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
  // Settlement needs BillingPlanChangeService after paid; this suite only
  // races claim/CAS/settlement locks — not entitlement activation. No-op
  // doubles satisfy the guard without mutating plan assignments.
  const noopPlanChangeService = {
    applyPaidPlanCharge: async () => undefined,
    extendEntitlementForPaidUsageInvoice: async () => undefined,
  };
  return new UsdcPaymentService(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
    new InvoiceSettlementService(noopPlanChangeService as never),
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
  let dbIdentityVerified = false;

  beforeAll(async () => {
    await prisma.$connect();
    await assertBillingE2eDatabaseIdentity(billingE2eDb, () =>
      queryBillingE2eIdentityWithPrisma(prisma),
    );
    dbIdentityVerified = true;
  });

  afterEach(async () => {
    if (!dbIdentityVerified) return;
    while (seeds.length > 0) {
      const seed = seeds[seeds.length - 1]!;
      await cleanup(seed);
      seeds.pop();
    }
  });

  afterAll(async () => {
    try {
      if (dbIdentityVerified) {
        while (seeds.length > 0) {
          const seed = seeds[seeds.length - 1]!;
          await cleanup(seed);
          seeds.pop();
        }
      }
    } finally {
      await prisma.$disconnect();
    }
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
    // lowercase hash; the migration-only unique `submitted_tx_hash` index
    // rejects the persist write (Prisma P2002) before any provider work, and
    // the loser is surfaced as duplicate_unallocated review — never a 500,
    // never a second provider claim, never a permanent pending.
    const resultB = await service.claim(seedB.userId, seedB.invoiceId, {
      paymentAttemptId: seedB.attemptId,
      txHash: '0x' + 'A'.repeat(64),
    });
    expect(resultB.status).toBe('needs_review');
    expect(resultB.reviewReason).toBe('duplicate_unallocated');
    // Only the winner performed provider work; the duplicate loser never
    // reached RPC.
    expect(provider.getTransactionReceipt).toHaveBeenCalledTimes(1);

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
    expect(attemptB!.failureCode).toBe('duplicate_submitted_hash'); // audit note
    expect(attemptB!.submittedTxHash).toBeNull(); // the rejected write never persisted
    expect(invoiceB!.paidAt).toBeNull();
  });

  it('first claim to persist a hash wins; a different-hash loser never calls RPC or binds evidence', async () => {
    const seed = await seedUsdcInvoice();
    seeds.push(seed);
    const txHashA = '0x' + 'a'.repeat(64);
    const txHashB = '0x' + 'b'.repeat(64);
    const blockHashA = '0x' + 'c'.repeat(64);

    const receiptA = confirmedReceiptFor(seed.payer, {
      transactionHash: txHashA,
      blockHash: blockHashA,
    });

    // Claim A persists hashA (persist-before-RPC, first-writer-wins) then
    // blocks inside its RPC call. Claim B's different hash can no longer be
    // persisted: its persist CAS matches zero rows (the null-or-equal guard
    // fails against the winner's recorded hash), so B returns the observed real
    // state WITHOUT any provider work.
    let releaseA: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let receiptCalls = 0;
    const provider = {
      getTransactionReceipt: jest.fn(async () => {
        receiptCalls++;
        if (receiptCalls === 1) await gateA;
        return receiptA;
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
    // The loser observed the winner-owned attempt: the real current state
    // (pending, retryable) — it never performed RPC work and never wrote
    // evidence. Only the winner performed provider work.
    expect(resultB.status).toBe('pending');
    expect(resultB.retryable).toBe(true);
    expect(provider.getTransactionReceipt).toHaveBeenCalledTimes(1);

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
    expect(attempt!.txHash).toBe(txHashA); // winner evidence preserved
    expect(attempt!.txHash).not.toBe(txHashB); // loser evidence never recorded
    expect(invoice!.paidAt).not.toBeNull();
    expect(invoice!.settlementAttemptId).toBe(seed.attemptId);
    expect(invoice!.paidVia).toBe('usdc');
  });

  it('two same-hash claims below the confirmation threshold converge on one confirming attempt', async () => {
    const seed = await seedUsdcInvoice();
    seeds.push(seed);

    // Same hash on the same attempt: both claims persist (the null-or-equal
    // guard matches the winner's hash), both verify the same evidence, but only
    // one evidence write wins under the real Postgres CAS; the other is an
    // idempotent confirming replay. The attempt stays confirming (4
    // confirmations < 5) with a single evidence identity.
    let releaseA: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let receiptCalls = 0;
    const provider = {
      getTransactionReceipt: jest.fn(async () => {
        receiptCalls++;
        if (receiptCalls === 1) await gateA;
        return confirmedReceiptFor(seed.payer);
      }),
      getBlockNumber: jest.fn(async () => 103n), // 4 confirmations → confirming path
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
    expect(resultB.status).toBe('confirming');
    expect(resultB.retryable).toBe(true);

    releaseA!();
    const resultA = await claimA;
    // Same evidence → idempotent confirming replay of the winner's evidence.
    expect(resultA.status).toBe('confirming');

    const attempt = await prisma.billingPaymentAttempt.findUnique({
      where: { id: seed.attemptId },
    });
    const invoice = await prisma.billingInvoice.findUnique({ where: { id: seed.invoiceId } });
    expect(attempt).not.toBeNull();
    expect(invoice).not.toBeNull();
    expect(attempt!.status).toBe('confirming');
    expect(attempt!.txHash).toBe(TX_HASH); // single evidence identity
    expect(invoice!.paidAt).toBeNull();
  });

  it('a different-hash loser is rejected at persist time and can never regress the winner to confirming', async () => {
    const seed = await seedUsdcInvoice();
    seeds.push(seed);
    const txHashA = '0x' + 'a'.repeat(64);
    const txHashB = '0x' + 'b'.repeat(64);

    // Winner A owns hashA and is gated inside its RPC call. Loser B claims a
    // different hash: the persist CAS matches zero rows, so B never reaches the
    // confirming path and can never regress A's outcome.
    let releaseA: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let receiptCalls = 0;
    const provider = {
      getTransactionReceipt: jest.fn(async () => {
        receiptCalls++;
        if (receiptCalls === 1) await gateA;
        return confirmedReceiptFor(seed.payer, { transactionHash: txHashA });
      }),
      getBlockNumber: jest.fn(async () => 103n), // 4 confirmations → confirming
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
    expect(resultB.status).toBe('pending');
    expect(resultB.retryable).toBe(true);
    expect(provider.getTransactionReceipt).toHaveBeenCalledTimes(1); // only the winner

    releaseA!();
    const resultA = await claimA;
    expect(resultA.status).toBe('confirming');
    expect(resultA.retryable).toBe(true);

    const attempt = await prisma.billingPaymentAttempt.findUnique({
      where: { id: seed.attemptId },
    });
    const invoice = await prisma.billingInvoice.findUnique({ where: { id: seed.invoiceId } });
    expect(attempt).not.toBeNull();
    expect(invoice).not.toBeNull();
    expect(attempt!.status).toBe('confirming');
    expect(attempt!.txHash).toBe(txHashA); // winner evidence preserved
    expect(attempt!.txHash).not.toBe(txHashB); // loser never bound evidence
    expect(attempt!.submittedTxHash).toBe(txHashA);
    expect(invoice!.paidAt).toBeNull();
  });

  it('a different-hash loser is rejected at persist time and can never regress the winner to review', async () => {
    const seed = await seedUsdcInvoice();
    seeds.push(seed);
    const txHashA = '0x' + 'a'.repeat(64);
    const txHashB = '0x' + 'b'.repeat(64);

    // Winner A owns hashA; its own receipt is defective (wrong amount), so A
    // alone drives the attempt to review. Loser B's different hash is rejected
    // at persist time and can never trigger or influence A's review.
    let releaseA: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let receiptCalls = 0;
    const provider = {
      getTransactionReceipt: jest.fn(async () => {
        receiptCalls++;
        if (receiptCalls === 1) await gateA;
        return confirmedReceiptFor(seed.payer, {
          transactionHash: txHashA,
          logs: [
            transferLog(seed.payer, {
              data: '0x' + (AMOUNT_MICROS - 1n).toString(16).padStart(64, '0'),
            }),
          ],
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
    expect(resultB.status).toBe('pending');
    expect(resultB.retryable).toBe(true);
    expect(provider.getTransactionReceipt).toHaveBeenCalledTimes(1); // only the winner

    releaseA!();
    const resultA = await claimA;
    // The winner's own review outcome (wrong amount) — never a regression of a
    // terminal state, because B never wrote anything.
    expect(resultA.status).toBe('needs_review');
    expect(resultA.reviewReason).toBe('wrong_amount');

    const attempt = await prisma.billingPaymentAttempt.findUnique({
      where: { id: seed.attemptId },
    });
    const invoice = await prisma.billingInvoice.findUnique({ where: { id: seed.invoiceId } });
    expect(attempt).not.toBeNull();
    expect(invoice).not.toBeNull();
    expect(attempt!.status).toBe('needs_review');
    expect(attempt!.reviewReason).toBe('wrong_amount'); // winner's own review
    expect(attempt!.submittedTxHash).toBe(txHashA); // loser never persisted its hash
    expect(invoice!.paidAt).toBeNull();
  });

  it('a different-hash loser is rejected at persist time and can never regress the winner to expired', async () => {
    const seed = await seedUsdcInvoice();
    seeds.push(seed);
    // Age the attempt so a missing receipt drives the winner to the expiry path.
    await prisma.billingPaymentAttempt.update({
      where: { id: seed.attemptId },
      data: {
        createdAt: new Date(Date.now() - 7200_000),
        quoteExpiresAt: new Date(Date.now() - 3600_000),
      },
    });
    const txHashA = '0x' + 'a'.repeat(64);
    const txHashB = '0x' + 'b'.repeat(64);

    // Winner A owns hashA and blocks inside its RPC call. Loser B claims a
    // different hash: the persist CAS matches zero rows, so B can never reach
    // the expiry path at all — only the winner's own missing receipt expires it.
    let releaseA: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let receiptCalls = 0;
    const provider = {
      getTransactionReceipt: jest.fn(async () => {
        receiptCalls++;
        if (receiptCalls === 1) await gateA;
        return null; // not mined → the winner's own flow expires the attempt
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
    expect(resultB.status).toBe('pending');
    expect(resultB.retryable).toBe(true);
    expect(provider.getTransactionReceipt).toHaveBeenCalledTimes(1); // only the winner

    releaseA!();
    const resultA = await claimA;
    expect(resultA.status).toBe('expired');
    expect(resultA.retryable).toBe(true);

    const attempt = await prisma.billingPaymentAttempt.findUnique({
      where: { id: seed.attemptId },
    });
    const invoice = await prisma.billingInvoice.findUnique({ where: { id: seed.invoiceId } });
    expect(attempt).not.toBeNull();
    expect(invoice).not.toBeNull();
    expect(attempt!.status).toBe('expired');
    expect(attempt!.reviewReason).toBe('quote_expired'); // winner's own expiry
    expect(attempt!.submittedTxHash).toBe(txHashA); // loser never persisted its hash
    expect(invoice!.paidAt).toBeNull();
  });
});
