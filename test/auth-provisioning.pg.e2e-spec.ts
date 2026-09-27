/**
 * Auth wallet provisioning crash-window/concurrency evidence against isolated PostgreSQL.
 * Requires BILLING_E2E_DATABASE_URL from the disposable billing E2E runner; never uses DATABASE_URL.
 */
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { ConfigService } from '@nestjs/config';
jest.mock('../src/core/openfort/openfort.service', () => ({ OpenfortService: class OpenfortService {} }));
import { AuthService } from '../src/modules/auth/auth.service';
import { bindProvisionedAccount } from '../src/modules/wallet-provisioning-recovery/bind-recovery';
import { BillingEntitlementService } from '../src/modules/billing/billing-entitlement.service';
import { BillingWalletLifecycleService } from '../src/modules/billing/billing-wallet-lifecycle.service';
import {
  applyBillingE2eDatabaseUrl,
  assertBillingE2eDatabaseIdentity,
  queryBillingE2eIdentityWithPrisma,
  resolveBillingE2eDatabaseTarget,
} from './billing-e2e-database';

const target = process.env.BILLING_E2E_DATABASE_URL ? resolveBillingE2eDatabaseTarget() : null;
const prisma = target ? new PrismaClient({ adapter: new PrismaPg(applyBillingE2eDatabaseUrl(target).url) }) : null;
const run = target ? describe : describe.skip;
const validAgent = { id: `agent-${randomUUID()}`, address: `0x${'a'.repeat(40)}`, keyHash: `0x${'b'.repeat(64)}` };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function services(openfort: Record<string, jest.Mock>) {
  if (!prisma) throw new Error('runner-provisioned PostgreSQL target required');
  const entitlements = new BillingEntitlementService(prisma as never);
  const lifecycle = new BillingWalletLifecycleService(prisma as never, entitlements);
  const auth = new AuthService(prisma as never, openfort as never, {} as never, {} as ConfigService, entitlements, lifecycle);
  return auth;
}

async function fixture(prefix: string) {
  if (!prisma) throw new Error('runner-provisioned PostgreSQL target required');
  const id = randomUUID();
  const user = await prisma.user.create({ data: { socialProvider: 'test', socialId: `${prefix}-${id}` } });
  await prisma.billingAccount.create({ data: { userId: user.id } });
  return user;
}

async function clean(userId: string) {
  if (!prisma) return;
  await prisma.securityEvent.deleteMany({ where: { userId } });
  await prisma.walletProvisioningIntent.deleteMany({ where: { wallet: { userId } } });
  await prisma.walletChainAuthorization.deleteMany({ where: { wallet: { userId } } });
  await prisma.userWallet.deleteMany({ where: { userId } });
  await prisma.billingAccount.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
}

function providerFor(iamUserId: string, accountIds: Map<string, string>, createAgentWallet: jest.Mock, extra: Record<string, unknown> = {}) {
  return {
    authorizeEmbeddedAddress: jest.fn(async (_token: string, address: string) => ({
      openfortUserId: iamUserId,
      accountId: accountIds.get(address.toLowerCase())!,
      address,
    })),
    createAgentWallet,
    ...extra,
  };
}

run('auth provisioning PostgreSQL crash windows', () => {
  beforeAll(async () => {
    if (!prisma || !target) throw new Error('runner-provisioned PostgreSQL target required');
    await assertBillingE2eDatabaseIdentity(target, () => queryBillingE2eIdentityWithPrisma(prisma));
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  it('coalesces simultaneous authorization of one binding to one durable intent and provider create', async () => {
    if (!prisma) throw new Error('runner-provisioned PostgreSQL target required');
    const user = await fixture('auth-same-binding');
    const address = `0x${'1'.repeat(40)}`;
    const create = jest.fn().mockResolvedValue(validAgent);
    const auth = services(providerFor(user.socialId, new Map([[address, `embedded-${user.id}`]]), create));
    try {
      const results = await Promise.allSettled([
        auth.authorizeEmbeddedWallet(user.socialId, 'token', { embeddedWalletAddress: address }),
        auth.authorizeEmbeddedWallet(user.socialId, 'token', { embeddedWalletAddress: address }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
      expect(create).toHaveBeenCalledTimes(1);
      expect(await prisma.userWallet.count({ where: { userId: user.id } })).toBe(1);
      expect(await prisma.walletProvisioningIntent.count({ where: { wallet: { userId: user.id }, status: 'completed' } })).toBe(1);
    } finally { await clean(user.id); }
  });

  it('allows only one distinct binding to reserve the final included slot', async () => {
    if (!prisma) throw new Error('runner-provisioned PostgreSQL target required');
    const user = await fixture('auth-last-slot');
    const create = jest.fn().mockResolvedValue(validAgent);
    const address = (n: string) => `0x${n.repeat(40)}`;
    const accounts = new Map([[address('2'), `account-a-${user.id}`], [address('3'), `account-b-${user.id}`]]);
    const auth = services(providerFor(user.socialId, accounts, create));
    try {
      for (let i = 0; i < 9; i += 1) {
        const wallet = await prisma.userWallet.create({ data: { userId: user.id, status: 'pending_embedded_wallet' } });
        await prisma.walletProvisioningIntent.create({ data: { walletId: wallet.id } });
      }
      const results = await Promise.allSettled([...accounts.keys()].map((embeddedWalletAddress) => auth.authorizeEmbeddedWallet(user.socialId, 'token', { embeddedWalletAddress })));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect(create).toHaveBeenCalledTimes(1);
      expect(await prisma.walletProvisioningIntent.count({ where: { wallet: { userId: user.id } } })).toBe(10);
    } finally { await clean(user.id); }
  });

  it('does not redispatch after timeout even when the late provider completion becomes known', async () => {
    if (!prisma) throw new Error('runner-provisioned PostgreSQL target required');
    const user = await fixture('auth-timeout-late');
    const address = `0x${'4'.repeat(40)}`;
    const gate = deferred<typeof validAgent>();
    const create = jest.fn().mockReturnValue(gate.promise);
    const auth = services(providerFor(user.socialId, new Map([[address, `account-${user.id}`]]), create));
    try {
      const first = auth.authorizeEmbeddedWallet(user.socialId, 'token', { embeddedWalletAddress: address });
      while (create.mock.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      gate.reject(new Error('provider timeout; outcome unknown'));
      await expect(first).rejects.toThrow('provider timeout');
      expect(await prisma.walletProvisioningIntent.findFirstOrThrow({ where: { wallet: { userId: user.id } } })).toMatchObject({ status: 'uncertain' });
      gate.resolve(validAgent); // Simulates a late completion; application has no callback/retry path.
      await expect(auth.authorizeEmbeddedWallet(user.socialId, 'token', { embeddedWalletAddress: address })).rejects.toThrow(/review/i);
      expect(create).toHaveBeenCalledTimes(1);
    } finally { await clean(user.id); }
  });

  it('retains dispatched intent after result persistence failure and never creates again', async () => {
    if (!prisma) throw new Error('runner-provisioned PostgreSQL target required');
    const user = await fixture('auth-result-persist-failure');
    const address = `0x${'5'.repeat(40)}`;
    const create = jest.fn().mockResolvedValue({ ...validAgent, id: `agent-${user.id}` });
    const auth = services(providerFor(user.socialId, new Map([[address, `account-${user.id}`]]), create));
    try {
      await prisma.$executeRawUnsafe(`CREATE FUNCTION fail_auth_provisioned_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = 'provisioned' THEN RAISE EXCEPTION 'injected result persistence failure'; END IF; RETURN NEW; END $$`);
      await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_auth_provisioned_write BEFORE UPDATE ON wallet_provisioning_intents FOR EACH ROW EXECUTE FUNCTION fail_auth_provisioned_write()`);
      await expect(auth.authorizeEmbeddedWallet(user.socialId, 'token', { embeddedWalletAddress: address })).rejects.toThrow();
      expect(await prisma.walletProvisioningIntent.findFirstOrThrow({ where: { wallet: { userId: user.id } } })).toMatchObject({ status: 'dispatched' });
      await prisma.$executeRawUnsafe('DROP TRIGGER fail_auth_provisioned_write ON wallet_provisioning_intents');
      await prisma.$executeRawUnsafe('DROP FUNCTION fail_auth_provisioned_write()');
      await expect(auth.authorizeEmbeddedWallet(user.socialId, 'token', { embeddedWalletAddress: address })).rejects.toThrow(/review/i);
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_auth_provisioned_write ON wallet_provisioning_intents').catch(() => undefined);
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS fail_auth_provisioned_write()').catch(() => undefined);
      await clean(user.id);
    }
  });

  it('retries activation from provisioned state after a frozen-user activation failure without another create', async () => {
    if (!prisma) throw new Error('runner-provisioned PostgreSQL target required');
    const user = await fixture('auth-activation-failure');
    const address = `0x${'6'.repeat(40)}`;
    const gate = deferred<typeof validAgent>();
    const entered = deferred<void>();
    const create = jest.fn(() => { entered.resolve(); return gate.promise; });
    const auth = services(providerFor(user.socialId, new Map([[address, `account-${user.id}`]]), create));
    try {
      const first = auth.authorizeEmbeddedWallet(user.socialId, 'token', { embeddedWalletAddress: address });
      await entered.promise;
      await prisma.user.update({ where: { id: user.id }, data: { frozenAt: new Date() } });
      gate.resolve({ ...validAgent, id: `agent-${user.id}` });
      await expect(first).rejects.toThrow(/frozen/i);
      expect(await prisma.walletProvisioningIntent.findFirstOrThrow({ where: { wallet: { userId: user.id } } })).toMatchObject({ status: 'provisioned' });
      await prisma.user.update({ where: { id: user.id }, data: { frozenAt: null } });
      await expect(auth.authorizeEmbeddedWallet(user.socialId, 'token', { embeddedWalletAddress: address })).resolves.toBeDefined();
      expect(create).toHaveBeenCalledTimes(1);
      expect(await prisma.walletProvisioningIntent.findFirstOrThrow({ where: { wallet: { userId: user.id } } })).toMatchObject({ status: 'completed' });
    } finally { await clean(user.id); }
  });

  it('operator binding wins the same dispatched-token CAS; normal result cannot mix identity and later activates it', async () => {
    if (!prisma) throw new Error('runner-provisioned PostgreSQL target required');
    const user = await fixture('auth-operator-result-race');
    const address = `0x${'7'.repeat(40)}`;
    const operatorAddress = `0x${'8'.repeat(40)}`;
    const gate = deferred<typeof validAgent>();
    const entered = deferred<void>();
    const create = jest.fn(() => { entered.resolve(); return gate.promise; });
    const auth = services(providerFor(user.socialId, new Map([[address, `embedded-${user.id}`]]), create));
    try {
      const normal = auth.authorizeEmbeddedWallet(user.socialId, 'token', { embeddedWalletAddress: address });
      await entered.promise;
      const wallet = await prisma.userWallet.findFirstOrThrow({ where: { userId: user.id, walletAddress: { not: null } } });
      const intent = await prisma.walletProvisioningIntent.findUniqueOrThrow({ where: { walletId: wallet.id } });
      expect(intent.status).toBe('dispatched');

      // Provider independently confirms an already-created account. Binding commits
      // while the normal provider create remains behind the deferred outcome barrier.
      await bindProvisionedAccount(
        prisma,
        { getAccount: jest.fn().mockResolvedValue({ id: `operator-agent-${user.id}`, address: operatorAddress, chainType: 'EVM', custody: 'Developer' }) },
        (providerAddress) => `0x${'c'.repeat(64)}`,
        { walletId: wallet.id, dispatchToken: intent.dispatchToken!, accountId: `operator-agent-${user.id}`, operator: 'test-operator', evidence: 'provider-record-verified' },
      );
      gate.resolve({ id: `normal-agent-${user.id}`, address: `0x${'9'.repeat(40)}`, keyHash: `0x${'d'.repeat(64)}` });
      await expect(normal).rejects.toThrow(/safely recorded/i);

      const bound = await prisma.walletProvisioningIntent.findUniqueOrThrow({ where: { walletId: wallet.id } });
      expect(bound).toMatchObject({ status: 'provisioned', agentOpenfortAccountId: `operator-agent-${user.id}`, agentWalletAddress: operatorAddress, agentKeyHash: `0x${'c'.repeat(64)}`, resolution: 'operator_bound' });
      expect(await prisma.securityEvent.count({ where: { userId: user.id, walletId: wallet.id, eventType: 'wallet.provisioning.recovered' } })).toBe(1);
      await expect(auth.authorizeEmbeddedWallet(user.socialId, 'token', { embeddedWalletAddress: address })).resolves.toBeDefined();
      const activated = await prisma.userWallet.findUniqueOrThrow({ where: { id: wallet.id } });
      expect(activated).toMatchObject({ status: 'active', agentOpenfortAccountId: `operator-agent-${user.id}`, agentWalletAddress: operatorAddress, agentKeyHash: `0x${'c'.repeat(64)}` });
      expect(await prisma.walletProvisioningIntent.count({ where: { walletId: wallet.id, status: 'completed' } })).toBe(1);
      expect(await prisma.securityEvent.count({ where: { userId: user.id, walletId: wallet.id, eventType: 'wallet.provisioning.recovered' } })).toBe(1);
      expect(create).toHaveBeenCalledTimes(1);
    } finally { await clean(user.id); }
  });

  it('rolls back repair of a legacy active wallet at the included-wallet cap without changing count or peak', async () => {
    if (!prisma) throw new Error('runner-provisioned PostgreSQL target required');
    const user = await fixture('auth-legacy-address-cap');
    const address = `0x${'e'.repeat(40)}`;
    const create = jest.fn();
    const auth = services(providerFor(user.socialId, new Map([[address, `legacy-embedded-${user.id}`]]), create));
    try {
      const starts = Array.from({ length: 10 }, (_, i) => prisma!.userWallet.create({ data: {
        userId: user.id, status: 'active', walletAddress: `0x${(i + 1).toString(16).padStart(40, '0')}`,
        openfortAccountId: `existing-${i}-${user.id}`, agentOpenfortAccountId: `legacy-agent-${i}-${user.id}`,
        agentWalletAddress: `0x${(i + 101).toString(16).padStart(40, '0')}`, agentKeyHash: `0x${(i + 1).toString(16).padStart(64, '0')}`,
      } }));
      await Promise.all(starts);
      const legacy = await prisma.userWallet.create({ data: {
        userId: user.id, status: 'active', openfortAccountId: `legacy-embedded-${user.id}`,
        agentOpenfortAccountId: `legacy-agent-missing-address-${user.id}`,
        agentWalletAddress: `0x${'f'.repeat(40)}`, agentKeyHash: `0x${'e'.repeat(64)}`,
      } });
      const before = await prisma.billingAccount.findUniqueOrThrow({ where: { userId: user.id } });
      await expect(auth.authorizeEmbeddedWallet(user.socialId, 'token', { embeddedWalletAddress: address })).rejects.toThrow(/quota|cap|included/i);
      expect(await prisma.userWallet.findUniqueOrThrow({ where: { id: legacy.id } })).toMatchObject({ openfortAccountId: `legacy-embedded-${user.id}`, walletAddress: null, status: 'active' });
      const after = await prisma.billingAccount.findUniqueOrThrow({ where: { userId: user.id } });
      expect(after.eligibleWalletCount).toBe(before.eligibleWalletCount);
      expect(after.walletCountObservedAt).toEqual(before.walletCountObservedAt);
      expect(await prisma.billingWalletUsagePeriod.count({ where: { billingAccountId: before.id } })).toBe(0);
      expect(create).not.toHaveBeenCalled();
    } finally { await clean(user.id); }
  });

  it('repairs legacy active address below cap and records eligible count/peak exactly once without creating an agent', async () => {
    if (!prisma) throw new Error('runner-provisioned PostgreSQL target required');
    const user = await fixture('auth-legacy-address-below-cap');
    const address = `0x${'d'.repeat(40)}`;
    const create = jest.fn();
    const auth = services(providerFor(user.socialId, new Map([[address, `legacy-embedded-${user.id}`]]), create));
    try {
      const legacy = await prisma.userWallet.create({ data: {
        userId: user.id, isDefault: true, status: 'active', openfortAccountId: `legacy-embedded-${user.id}`,
        agentOpenfortAccountId: `legacy-agent-${user.id}`, agentWalletAddress: `0x${'f'.repeat(40)}`, agentKeyHash: `0x${'a'.repeat(64)}`,
      } });
      await auth.authorizeEmbeddedWallet(user.socialId, 'token', { embeddedWalletAddress: address });
      const first = await prisma.userWallet.findUniqueOrThrow({ where: { id: legacy.id } });
      expect(first.walletAddress?.toLowerCase()).toBe(address);
      const account = await prisma.billingAccount.findUniqueOrThrow({ where: { userId: user.id } });
      expect(account.eligibleWalletCount).toBe(1);
      const month = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
      const peak = await prisma.billingWalletUsagePeriod.findUniqueOrThrow({ where: { billingAccountId_periodStart: { billingAccountId: account.id, periodStart: month } } });
      expect(peak.peakWalletCount).toBe(1);
      await auth.authorizeEmbeddedWallet(user.socialId, 'token', { embeddedWalletAddress: address });
      expect(await prisma.billingWalletUsagePeriod.count({ where: { billingAccountId: account.id, periodStart: month } })).toBe(1);
      expect((await prisma.billingWalletUsagePeriod.findUniqueOrThrow({ where: { billingAccountId_periodStart: { billingAccountId: account.id, periodStart: month } } })).peakWalletCount).toBe(1);
      expect((await prisma.billingAccount.findUniqueOrThrow({ where: { userId: user.id } })).eligibleWalletCount).toBe(1);
      expect(create).not.toHaveBeenCalled();
    } finally { await clean(user.id); }
  });

  it('repairs an active legacy wallet without an existing billing account and records its first eligible baseline', async () => {
    if (!prisma) throw new Error('runner-provisioned PostgreSQL target required');
    const id = randomUUID();
    const user = await prisma.user.create({ data: { socialProvider: 'test', socialId: `auth-legacy-no-account-${id}` } });
    const address = `0x${'c'.repeat(40)}`;
    const create = jest.fn();
    const auth = services(providerFor(user.socialId, new Map([[address, `legacy-embedded-${user.id}`]]), create));
    try {
      const legacy = await prisma.userWallet.create({ data: {
        userId: user.id, status: 'active', openfortAccountId: `legacy-embedded-${user.id}`,
        agentOpenfortAccountId: `legacy-agent-${user.id}`, agentWalletAddress: `0x${'b'.repeat(40)}`, agentKeyHash: `0x${'9'.repeat(64)}`,
      } });
      expect(await prisma.billingAccount.findUnique({ where: { userId: user.id } })).toBeNull();
      await auth.authorizeEmbeddedWallet(user.socialId, 'token', { embeddedWalletAddress: address });
      const account = await prisma.billingAccount.findUniqueOrThrow({ where: { userId: user.id } });
      expect(await prisma.userWallet.findUniqueOrThrow({ where: { id: legacy.id } })).toMatchObject({ walletAddress: address });
      expect(account.eligibleWalletCount).toBe(1);
      const month = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
      expect((await prisma.billingWalletUsagePeriod.findUniqueOrThrow({ where: { billingAccountId_periodStart: { billingAccountId: account.id, periodStart: month } } })).peakWalletCount).toBe(1);
      expect(create).not.toHaveBeenCalled();
    } finally { await clean(user.id); }
  });

  it('renews expired failed registration on explicit future expiry and accepts a registration retry', async () => {
    if (!prisma) throw new Error('runner-provisioned PostgreSQL target required');
    const user = await fixture('auth-registration-renewal');
    const address = `0x${'1'.repeat(40)}`;
    const chainId = 84532;
    const create = jest.fn();
    const verify = jest.fn().mockResolvedValue(true);
    const auth = services(providerFor(user.socialId, new Map([[address, `embedded-${user.id}`]]), create, { verifyAgentKeyRegistration: verify }));
    try {
      const wallet = await prisma.userWallet.create({ data: {
        userId: user.id, isDefault: true, status: 'active', openfortAccountId: `embedded-${user.id}`, walletAddress: address,
        agentOpenfortAccountId: `agent-${user.id}`, agentWalletAddress: `0x${'2'.repeat(40)}`, agentKeyHash: `0x${'3'.repeat(64)}`,
      } });
      await prisma.walletChainAuthorization.create({ data: { walletId: wallet.id, chainId: BigInt(chainId), status: 'registration_failed', registrationTxHash: `0x${'4'.repeat(64)}`, expiresAt: new Date(Date.now() - 60_000) } });
      const expiry = new Date(Date.now() + 60 * 60_000).toISOString();
      await auth.authorizeEmbeddedWallet(user.socialId, 'token', { embeddedWalletAddress: address, chainId, agentExpiresAt: expiry });
      expect(await prisma.walletChainAuthorization.findUniqueOrThrow({ where: { walletId_chainId: { walletId: wallet.id, chainId: BigInt(chainId) } } })).toMatchObject({ status: 'registration_required', registrationTxHash: null, expiresAt: new Date(expiry) });
      const txHash = `0x${'5'.repeat(64)}`;
      await auth.markAgentRegistrationTransaction(user.socialId, chainId, txHash, wallet.id);
      await auth.markAgentRegistrationResult(user.socialId, chainId, 'registered', txHash, wallet.id);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(await prisma.walletChainAuthorization.findUniqueOrThrow({ where: { walletId_chainId: { walletId: wallet.id, chainId: BigInt(chainId) } } })).toMatchObject({ status: 'registered', registrationTxHash: txHash });
      expect(create).not.toHaveBeenCalled();
    } finally { await clean(user.id); }
  });

  it('does not let reauthorization overwrite a registration hash that won while provider identity verification was pending', async () => {
    if (!prisma) throw new Error('runner-provisioned PostgreSQL target required');
    const user = await fixture('auth-registration-hash-race');
    const address = `0x${'6'.repeat(40)}`;
    const chainId = 84532;
    const entered = deferred<void>();
    const verification = deferred<{ openfortUserId: string; accountId: string; address: string }>();
    const create = jest.fn();
    const auth = services(providerFor(user.socialId, new Map([[address, `embedded-${user.id}`]]), create, {
      authorizeEmbeddedAddress: jest.fn(() => { entered.resolve(); return verification.promise; }),
    }));
    try {
      const wallet = await prisma.userWallet.create({ data: {
        userId: user.id, isDefault: true, status: 'active', openfortAccountId: `embedded-${user.id}`, walletAddress: address,
        agentOpenfortAccountId: `agent-${user.id}`, agentWalletAddress: `0x${'7'.repeat(40)}`, agentKeyHash: `0x${'8'.repeat(64)}`,
      } });
      await prisma.walletChainAuthorization.create({ data: { walletId: wallet.id, chainId: BigInt(chainId), status: 'registration_failed', registrationTxHash: `0x${'9'.repeat(64)}`, expiresAt: new Date(Date.now() - 60_000) } });
      const reauthorize = auth.authorizeEmbeddedWallet(user.socialId, 'token', { embeddedWalletAddress: address, chainId, agentExpiresAt: new Date(Date.now() + 3600_000).toISOString() });
      await entered.promise;
      const winningHash = `0x${'a'.repeat(64)}`;
      await auth.markAgentRegistrationTransaction(user.socialId, chainId, winningHash, wallet.id);
      verification.resolve({ openfortUserId: user.socialId, accountId: `embedded-${user.id}`, address });
      await reauthorize;
      expect(await prisma.walletChainAuthorization.findUniqueOrThrow({ where: { walletId_chainId: { walletId: wallet.id, chainId: BigInt(chainId) } } })).toMatchObject({ status: 'pending_registration', registrationTxHash: winningHash });
      expect(create).not.toHaveBeenCalled();
    } finally { await clean(user.id); }
  });
});
