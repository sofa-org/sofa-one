/** Real PostgreSQL coverage for concurrent USDC quote payer selection. */
import { randomUUID, createHash } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/core/database/prisma.service';
import { InvoiceSettlementService } from '../src/modules/billing/invoice-settlement.service';
import { UsdcPaymentService } from '../src/modules/billing/onchain/usdc-payment.service';
import type { UsdcReceiptProvider } from '../src/modules/billing/onchain/usdc-receipt.provider';
import {
  applyBillingE2eDatabaseUrl, assertBillingE2eDatabaseIdentity,
  queryBillingE2eIdentityWithPrisma, resolveBillingE2eDatabaseTarget,
} from './billing-e2e-database';

const target = process.env.BILLING_E2E_DATABASE_URL ? resolveBillingE2eDatabaseTarget() : null;
const prisma = target ? new PrismaClient({ adapter: new PrismaPg(applyBillingE2eDatabaseUrl(target).url) }) : null;
const run = target ? describe : describe.skip;
const amount = 49_000_000n;
const treasury = '0x1111111111111111111111111111111111111111';
const token = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const rpc = 'https://base.example.com/rpc';

async function fixture() {
  const id = randomUUID();
  const user = await prisma!.user.create({ data: { socialProvider: 'wallet-usdc-quote', socialId: id } });
  const account = await prisma!.billingAccount.create({ data: { userId: user.id } });
  const periodStart = new Date('2026-07-01T00:00:00.000Z');
  const periodEnd = new Date('2026-08-01T00:00:00.000Z');
  const plan = await prisma!.billingPlanVersion.create({
    data: { code: `mw-usdc-${id}`, version: 1, name: 'Quote race', effectiveFrom: periodStart },
  });
  const invoice = await prisma!.billingInvoice.create({ data: {
    billingAccountId: account.id, planVersionId: plan.id, periodStart, periodEnd,
    status: 'finalized', currency: 'USD', grossOutboundMicros: 0n, billableOutboundMicros: 0n,
    apiCalls: 0n, activeWallets: 0, monthlyFeeMicros: amount, outboundOverageMicros: 0n,
    apiOverageMicros: 0n, walletOverageMicros: 0n, totalMicros: amount, snapshotJson: {},
    snapshotHash: `quote-${id}`, finalizedAt: new Date(),
  } });
  const wallets = await Promise.all([0, 1].map((n) => prisma!.userWallet.create({ data: {
    userId: user.id, status: 'active', walletAddress: `0x${createHash('sha256').update(`${id}:${n}`).digest('hex').slice(0, 40)}`,
  } })));
  return { userId: user.id, accountId: account.id, planId: plan.id, invoiceId: invoice.id, wallets };
}

async function clean(seed: Awaited<ReturnType<typeof fixture>>) {
  await prisma!.billingPaymentAttempt.deleteMany({ where: { invoiceId: seed.invoiceId } });
  await prisma!.billingInvoice.delete({ where: { id: seed.invoiceId } });
  await prisma!.billingPlanVersion.delete({ where: { id: seed.planId } });
  await prisma!.billingAccount.delete({ where: { id: seed.accountId } });
  await prisma!.userWallet.deleteMany({ where: { userId: seed.userId } });
  await prisma!.user.delete({ where: { id: seed.userId } });
}

function service() {
  const config = { get: (key: string) => ({
    'billing.usdc.enabled': true,
    'billing.usdc.treasuryAddresses.8453': treasury,
    'billing.usdc.rpcUrls.8453': rpc,
    'billing.usdc.requiredConfirmations': 5,
    'billing.usdc.quoteTtlSeconds': 86400,
    'chain.defaultChainId': 84532,
  } as Record<string, unknown>)[key] };
  const noProvider: UsdcReceiptProvider = {
    getTransactionReceipt: jest.fn(), getBlockNumber: jest.fn(),
  };
  return new UsdcPaymentService(
    prisma as unknown as PrismaService, config as unknown as ConfigService,
    new InvoiceSettlementService({} as never), noProvider,
  );
}

run('multi-wallet USDC quote PostgreSQL races', () => {
  beforeAll(async () => {
    await prisma!.$connect();
    await assertBillingE2eDatabaseIdentity(target!, () => queryBillingE2eIdentityWithPrisma(prisma!));
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  it('creates one attempt and never returns payer A to concurrent payer B', async () => {
    const seed = await fixture();
    try {
      const result = await Promise.allSettled(seed.wallets.map((wallet) =>
        service().quote(seed.userId, seed.invoiceId, 8453, wallet.id)));
      const attempts = await prisma!.billingPaymentAttempt.findMany({ where: { invoiceId: seed.invoiceId, status: 'pending' } });
      expect(attempts).toHaveLength(1);
      const winnerPayer = attempts[0].expectedPayerAddress;
      expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const [index, outcome] of result.entries()) {
        if (outcome.status === 'fulfilled') {
          expect(outcome.value.expectedPayerAddress).toBe(seed.wallets[index].walletAddress);
          expect(outcome.value.expectedPayerAddress).toBe(winnerPayer);
        }
      }
      expect(result.filter((r) => r.status === 'rejected')).toHaveLength(1);
    } finally { await clean(seed); }
  });

  it('reuses a same-payer concurrent quote', async () => {
    const seed = await fixture();
    try {
      const [a, b] = await Promise.all([0, 1].map(() =>
        service().quote(seed.userId, seed.invoiceId, 8453, seed.wallets[0].id)));
      expect(a.paymentAttemptId).toBe(b.paymentAttemptId);
      expect(a.expectedPayerAddress).toBe(seed.wallets[0].walletAddress);
      expect(await prisma!.billingPaymentAttempt.count({ where: { invoiceId: seed.invoiceId, status: 'pending' } })).toBe(1);
    } finally { await clean(seed); }
  });

  it('replaces a clean expired attempt with a different payer, but protects evidence-bearing attempts', async () => {
    const seed = await fixture();
    try {
      const first = await service().quote(seed.userId, seed.invoiceId, 8453, seed.wallets[0].id);
      await prisma!.billingPaymentAttempt.update({ where: { id: first.paymentAttemptId }, data: { quoteExpiresAt: new Date(Date.now() - 1000) } });
      const replacement = await service().quote(seed.userId, seed.invoiceId, 8453, seed.wallets[1].id);
      expect(replacement.paymentAttemptId).not.toBe(first.paymentAttemptId);
      expect(replacement.expectedPayerAddress).toBe(seed.wallets[1].walletAddress);

      await prisma!.billingPaymentAttempt.update({ where: { id: replacement.paymentAttemptId }, data: {
        quoteExpiresAt: new Date(Date.now() - 1000), submittedTxHash: `0x${'a'.repeat(64)}`,
      } });
      await expect(service().quote(seed.userId, seed.invoiceId, 8453, seed.wallets[0].id)).rejects.toThrow();
      const attempts = await prisma!.billingPaymentAttempt.findMany({ where: { invoiceId: seed.invoiceId } });
      expect(attempts).toHaveLength(2);
      expect(attempts.find((attempt) => attempt.id === replacement.paymentAttemptId)).toMatchObject({
        expectedPayerAddress: seed.wallets[1].walletAddress,
        submittedTxHash: `0x${'a'.repeat(64)}`,
      });
    } finally { await clean(seed); }
  });
});
