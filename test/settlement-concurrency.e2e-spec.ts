/**
 * Real-PostgreSQL concurrency integration test for invoice settlement.
 *
 * Uses the real DATABASE_URL (docker-compose Postgres) — no mocks. Creates its
 * own finalized invoice + succeeded attempts, actually races two settlements
 * and a success/failure transition in concurrent interactive transactions,
 * asserts the invariants (at most one settlement, consistent paidVia/pointer,
 * no state overwrite), and cleans up its own data.
 *
 * Runs via `npm run test:e2e` (maxWorkers=1) following the repo convention for
 * DB-dependent tests. Requires a reachable Postgres at DATABASE_URL.
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { InvoiceSettlementService } from '../src/modules/billing/invoice-settlement.service';

const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
const settlementService = new InvoiceSettlementService();

const AMOUNT_MICROS = 49_000_000n;

interface SeededInvoice {
  userId: string;
  accountId: string;
  planId: string;
  invoiceId: string;
  attemptIds: string[];
}

async function seedInvoice(
  attempts: Array<{ method: 'stripe' | 'usdc'; status: 'pending' | 'succeeded' }>,
): Promise<SeededInvoice> {
  const userId = randomUUID();
  const accountId = randomUUID();
  const planId = randomUUID();
  const invoiceId = randomUUID();
  const periodStart = new Date('2026-07-01T00:00:00.000Z');
  const periodEnd = new Date('2026-08-01T00:00:00.000Z');

  await prisma.user.create({
    data: { id: userId, socialProvider: 'test', socialId: `concurrency-${userId}` },
  });
  await prisma.billingAccount.create({ data: { id: accountId, userId } });
  await prisma.billingPlanVersion.create({
    data: {
      id: planId,
      code: `test-plan-${userId}`,
      version: 1,
      name: 'Concurrency Test Plan',
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
      snapshotHash: 'concurrency-test',
      finalizedAt: new Date(),
    },
  });

  const attemptIds: string[] = [];
  for (const a of attempts) {
    const attemptId = randomUUID();
    await prisma.billingPaymentAttempt.create({
      data: {
        id: attemptId,
        invoiceId,
        method: a.method,
        status: a.status,
        amountMicros: AMOUNT_MICROS,
        currency: 'USD',
        ...(a.status === 'succeeded' ? { succeededAt: new Date() } : {}),
      },
    });
    attemptIds.push(attemptId);
  }
  return { userId, accountId, planId, invoiceId, attemptIds };
}

async function cleanup(seed: SeededInvoice): Promise<void> {
  await prisma.billingPaymentAttempt.deleteMany({ where: { invoiceId: seed.invoiceId } });
  await prisma.billingInvoice.delete({ where: { id: seed.invoiceId } });
  await prisma.billingPlanVersion.delete({ where: { id: seed.planId } });
  await prisma.billingAccount.delete({ where: { id: seed.accountId } });
  await prisma.user.delete({ where: { id: seed.userId } });
}

describe('InvoiceSettlementService concurrency (real PostgreSQL)', () => {
  const seeds: SeededInvoice[] = [];

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

  it('settles at most once when two rails race on the same invoice', async () => {
    // Run the race a few times to exercise both lock-acquisition orders.
    for (let i = 0; i < 3; i++) {
      const seed = await seedInvoice([
        { method: 'stripe', status: 'succeeded' },
        { method: 'usdc', status: 'succeeded' },
      ]);
      seeds.push(seed);
      const [stripeId, usdcId] = seed.attemptIds;

      const results = await Promise.all([
        prisma.$transaction(
          (tx) =>
            settlementService.settleInvoice(tx, {
              id: stripeId,
              invoiceId: seed.invoiceId,
              method: 'stripe',
            }),
          { timeout: 15000 },
        ),
        prisma.$transaction(
          (tx) =>
            settlementService.settleInvoice(tx, {
              id: usdcId,
              invoiceId: seed.invoiceId,
              method: 'usdc',
            }),
          { timeout: 15000 },
        ),
      ]);

      const winners = [stripeId, usdcId].filter((_, idx) => results[idx].paidByThisAttempt);
      expect(winners.length).toBe(1);

      const invoice = await prisma.billingInvoice.findUnique({
        where: { id: seed.invoiceId },
      });
      expect(invoice).not.toBeNull();
      expect(invoice!.paidAt).not.toBeNull();
      expect(invoice!.settlementAttemptId).toBe(winners[0]);
      expect(invoice!.paidVia).toBe(winners[0] === stripeId ? 'stripe' : 'usdc');
    }
  });

  it('never regresses a succeeded attempt via a concurrent failure CAS', async () => {
    const seed = await seedInvoice([{ method: 'stripe', status: 'pending' }]);
    seeds.push(seed);
    const attemptId = seed.attemptIds[0];

    let failureReadDone: () => void;
    const failureRead = new Promise<void>((resolve) => {
      failureReadDone = resolve;
    });
    let successCommitted: () => void;
    const successDone = new Promise<void>((resolve) => {
      successCommitted = resolve;
    });

    // Failure tx: reads the attempt as pending (a stale snapshot under Read
    // Committed), then holds the transaction open while the success commits,
    // then attempts the failure CAS — which must match zero rows.
    const failureTx = prisma.$transaction(
      async (tx) => {
        const attempt = await tx.billingPaymentAttempt.findUnique({
          where: { id: attemptId },
        });
        expect(attempt).not.toBeNull();
        expect(attempt!.status).toBe('pending');
        failureReadDone();
        await successDone;
        const res = await tx.billingPaymentAttempt.updateMany({
          where: { id: attemptId, status: 'pending' },
          data: {
            status: 'failed',
            failedAt: new Date(),
            failureCode: 'card_declined',
            failureMessage: 'Your card was declined.',
          },
        });
        return res.count;
      },
      { timeout: 15000 },
    );

    // Success tx: waits for the failure tx to read pending, then commits the
    // success transition and settles the invoice.
    const successTx = (async () => {
      await failureRead;
      return prisma.$transaction(
        async (tx) => {
          await tx.billingPaymentAttempt.update({
            where: { id: attemptId },
            data: {
              status: 'succeeded',
              succeededAt: new Date(),
              failedAt: null,
              failureCode: null,
              failureMessage: null,
            },
          });
          await settlementService.settleInvoice(tx, {
            id: attemptId,
            invoiceId: seed.invoiceId,
            method: 'stripe',
          });
          successCommitted();
        },
        { timeout: 15000 },
      );
    })();

    const [failureCount] = await Promise.all([failureTx, successTx]);
    // The failure CAS ran after the success committed: it must match zero rows
    // and never regress the succeeded attempt or its settlement.
    expect(failureCount).toBe(0);

    const attempt = await prisma.billingPaymentAttempt.findUnique({
      where: { id: attemptId },
    });
    const invoice = await prisma.billingInvoice.findUnique({
      where: { id: seed.invoiceId },
    });
    expect(attempt).not.toBeNull();
    expect(invoice).not.toBeNull();
    expect(attempt!.status).toBe('succeeded');
    expect(attempt!.failedAt).toBeNull();
    expect(invoice!.paidAt).not.toBeNull();
    expect(invoice!.paidVia).toBe('stripe');
    expect(invoice!.settlementAttemptId).toBe(attemptId);
  });
});
