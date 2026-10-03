/** Multi-wallet ownership and selector checks against runner-owned PostgreSQL. */
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { ConfigService } from '@nestjs/config';
import { ForbiddenException } from '@nestjs/common';

// Avoid loading the provider SDK (and its ESM-only jose dependency) in this
// direct-service PostgreSQL suite. Service methods still execute normally.
jest.mock('../src/core/openfort/openfort.service', () => ({
  OpenfortService: class OpenfortService {},
}));

import { WalletService } from '../src/modules/wallet/wallet.service';
import { TransactionsService } from '../src/modules/transactions/transactions.service';
import { DefiPolicyDenial } from '../src/modules/defi/defi.types';
import {
  applyBillingE2eDatabaseUrl, assertBillingE2eDatabaseIdentity,
  queryBillingE2eIdentityWithPrisma, resolveBillingE2eDatabaseTarget,
} from './billing-e2e-database';

const target = process.env.BILLING_E2E_DATABASE_URL ? resolveBillingE2eDatabaseTarget() : null;
const prisma = target ? new PrismaClient({ adapter: new PrismaPg(applyBillingE2eDatabaseUrl(target).url) }) : null;
const run = target ? describe : describe.skip;
const chainId = 84532;

async function fixture(label: string) {
  const id = randomUUID();
  const user = await prisma!.user.create({ data: { socialProvider: 'multi-wallet-test', socialId: `${label}-${id}` } });
  const wallets: Array<{ id: string; walletAddress: string | null; agentOpenfortAccountId: string | null }> = [];
  try {
    for (const n of [0, 1]) {
      // UUID-derived addresses remain unique across fixture owners as well as
      // within the fixture, satisfying globally unique wallet address indexes.
      const unique = `${id.replace(/-/g, '')}${n.toString().padStart(8, '0')}`;
      const agent = `${id.replace(/-/g, '')}${(n + 2).toString().padStart(8, '0')}`;
      const wallet = await prisma!.userWallet.create({ data: {
        userId: user.id, status: 'active', walletAddress: `0x${unique}`,
        openfortAccountId: `embedded-${id}-${n}`, agentOpenfortAccountId: `agent-${id}-${n}`,
        agentWalletAddress: `0x${agent}`, agentKeyHash: `0x${id.replace(/-/g, '').padStart(64, '0')}`,
      } });
      wallets.push(wallet);
      await prisma!.walletChainAuthorization.create({ data: { walletId: wallet.id, chainId: BigInt(chainId), status: 'registered', expiresAt: new Date(Date.now() + 3600_000) } });
    }
    return { user, wallets };
  } catch (error) {
    await clean(user.id);
    throw error;
  }
}

async function clean(userId: string) {
  await prisma!.securityEvent.deleteMany({ where: { userId } });
  await prisma!.signingRequest.deleteMany({ where: { userId } });
  await prisma!.apiKey.deleteMany({ where: { userId } });
  await prisma!.walletChainAuthorization.deleteMany({ where: { wallet: { userId } } });
  await prisma!.userWallet.deleteMany({ where: { userId } });
  await prisma!.user.deleteMany({ where: { id: userId } });
}

run('multi-wallet execution PostgreSQL', () => {
  beforeAll(async () => {
    if (!prisma || !target) throw new Error('runner-provisioned PostgreSQL target required');
    await assertBillingE2eDatabaseIdentity(target, () => queryBillingE2eIdentityWithPrisma(prisma));
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  it('scopes explicit foreign wallet ids to owner and rejects implicit selection with multiple active wallets', async () => {
    const owner = await fixture('owner');
    const other = await fixture('other');
    const key = { id: randomUUID(), userId: owner.user.id, keyPrefix: 'sk_test', canSign: true, canSendTransaction: true, allowedCapabilityIds: [] };
    const sideEffect = jest.fn();
    const walletService = new WalletService(prisma as never, { signData: sideEffect } as never, {} as never, {} as never, { authorizeSigning: () => { throw new Error('unused'); }, recordDenied: jest.fn() } as never);
    const transactionService = new TransactionsService(
      prisma as never, { sendUserOperation: sideEffect } as never,
      { assertAllowed: jest.fn() } as never, {} as never, {} as ConfigService,
      { assertDestinationsAllowed: jest.fn() } as never,
      { authorizeContractCalls: jest.fn(), assertStillAuthorized: jest.fn(), recordAllowedInTx: jest.fn(), recordDenied: jest.fn() } as never,
      { exportCommitted: jest.fn() } as never,
    );
    try {
      await expect(walletService.sign(owner.user.id, {
        walletId: other.wallets[0].id, type: 'message', message: 'test', chainId,
      }, key as never)).rejects.toThrow(/wallet not found/i);
      await expect(transactionService.send(owner.user.id, {
        walletId: other.wallets[0].id, chainId, idempotencyKey: randomUUID(),
        interactions: [{ to: `0x${'a'.repeat(40)}`, data: '0x12345678', value: '0' }],
      } as never, key as never)).rejects.toThrow(/wallet not found/i);
      await expect(transactionService.send(owner.user.id, {
        chainId, idempotencyKey: randomUUID(),
        interactions: [{ to: `0x${'a'.repeat(40)}`, data: '0x12345678', value: '0' }],
      } as never, key as never)).rejects.toThrow(/walletId is required/i);
      expect(sideEffect).not.toHaveBeenCalled();
    } finally { await clean(owner.user.id); await clean(other.user.id); }
  });

  it('denies API-key signing before Openfort in the MVP', async () => {
    const owner = await fixture('sign-owner');
    const key = { id: randomUUID(), userId: owner.user.id, keyPrefix: 'sk_test', canSign: true, canSendTransaction: true, allowedCapabilityIds: [] };
    await prisma!.apiKey.create({ data: {
      id: key.id, userId: owner.user.id, apiKeyHash: 'isolated-test-only',
      keyPrefix: 'sk_test', allowedIps: [],
    } });
    const signData = jest.fn().mockResolvedValue(`0x${'a'.repeat(130)}`);
    const walletService = new WalletService(
      prisma as never, { signData } as never,
      { acquireUserDestinationLock: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      { authorizeSigning: () => { throw new DefiPolicyDenial(new ForbiddenException({ code: 'DEFI_FUNCTION_NOT_ALLOWED' }), { code: 'DEFI_FUNCTION_NOT_ALLOWED' }); }, recordDenied: jest.fn() } as never,
    );
    try {
      await expect(walletService.sign(owner.user.id, {
        walletId: owner.wallets[1].id, type: 'message', message: 'integration', chainId,
      }, key as never)).rejects.toMatchObject({ response: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
      expect(signData).not.toHaveBeenCalled();
    } finally { await clean(owner.user.id); }
  });

  it('requires a wallet selector for dashboard quote payer when multiple active wallets exist', async () => {
    const owner = await fixture('quote-owner');
    const service = new WalletService(prisma as never, {} as never, {} as never, {} as never, {} as never);
    try {
      await expect(service.getDepositInfo(owner.user.id, chainId)).rejects.toThrow(/walletId is required/i);
      await expect(service.getDepositInfo(owner.user.id, chainId, owner.wallets[1].id)).resolves.toMatchObject({ walletAddress: owner.wallets[1].walletAddress });
    } finally { await clean(owner.user.id); }
  });
});
