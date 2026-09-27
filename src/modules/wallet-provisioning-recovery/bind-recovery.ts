import { getAddress } from 'viem';

export type BindRecoveryInput = {
  walletId: string;
  dispatchToken: string;
  accountId: string;
  operator: string;
  evidence: string;
  expectedAddress?: string;
};

/** Resolve an exact account from the raw v2 list API; never infer missing provider fields. */
export async function findRawProviderAccount(
  listAccounts: (params: { chainType: 'EVM'; custody: 'Developer'; limit: number; skip: number }) => Promise<any>,
  accountId: string,
): Promise<any> {
  const limit = 100;
  const maxAccounts = 10_000;
  let total: number | undefined;
  let match: any;
  for (let skip = 0; skip < (total ?? maxAccounts); skip += limit) {
    const page = await listAccounts({ chainType: 'EVM', custody: 'Developer', limit, skip });
    if (!Array.isArray(page?.data) || !Number.isInteger(page.total) || page.total < 0 || page.data.length > limit) {
      throw new Error('Invalid raw provider account list response');
    }
    const pageTotal = page.total as number;
    total = pageTotal;
    if (pageTotal > maxAccounts || page.data.length < Math.min(limit, Math.max(0, pageTotal - skip))) {
      throw new Error('Provider account list is truncated or exceeds the safe recovery scan limit');
    }
    for (const account of page.data) {
      if (account?.id === accountId) {
        if (match) throw new Error('Provider account ID is ambiguous');
        match = account;
      }
    }
  }
  if (!match) throw new Error('Provider account ID not found in raw account list');
  return match;
}

/** Bind an already-created provider account. This function never creates accounts. */
export async function bindProvisionedAccount(
  prisma: any,
  provider: { getAccount(id: string): Promise<any> },
  computeKeyHash: (address: string) => string,
  input: BindRecoveryInput,
): Promise<void> {
  for (const [name, value] of Object.entries(input)) {
    if (name !== 'expectedAddress' && (!value || !value.trim())) throw new Error(`Missing ${name}`);
  }
  const account = await provider.getAccount(input.accountId);
  if (!account || typeof account.id !== 'string' || account.id !== input.accountId) throw new Error('Provider account ID mismatch');
  if (account.chainType !== 'EVM' || account.custody !== 'Developer') throw new Error('Provider account must be Developer custody EVM');
  if (typeof account.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(account.address)) throw new Error('Invalid provider address');
  const address = getAddress(account.address);
  if (input.expectedAddress && getAddress(input.expectedAddress) !== address) throw new Error('Provider address mismatch');
  const hash = computeKeyHash(address);
  const owner = await prisma.userWallet.findUnique({ where: { id: input.walletId }, select: { userId: true } });
  if (!owner) throw new Error('Wallet not found');
  const billingAccount = await prisma.billingAccount.upsert({ where: { userId: owner.userId }, create: { userId: owner.userId }, update: {}, select: { id: true } });
  await prisma.$transaction(async (tx: any) => {
    // Match billing lifecycle lock order: billing account before wallet.
    await tx.$queryRaw`SELECT id FROM billing_accounts WHERE id = ${billingAccount.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM user_wallets WHERE id = ${input.walletId}::uuid FOR UPDATE`;
    const intent = await tx.walletProvisioningIntent.findUnique({ where: { walletId: input.walletId } });
    if (!intent || intent.dispatchToken !== input.dispatchToken || !['dispatched', 'uncertain'].includes(intent.status)) {
      throw new Error('Intent/token/status mismatch; no changes made');
    }
    const wallet = await tx.userWallet.findUnique({ where: { id: input.walletId } });
    if (!wallet) throw new Error('Wallet not found');
    if (wallet.userId !== owner.userId) throw new Error('Wallet owner changed during recovery');
    if ((wallet.agentOpenfortAccountId && wallet.agentOpenfortAccountId !== input.accountId) ||
        (wallet.agentWalletAddress && wallet.agentWalletAddress.toLowerCase() !== address.toLowerCase()) ||
        (wallet.agentKeyHash && wallet.agentKeyHash.toLowerCase() !== hash.toLowerCase())) throw new Error('Wallet already has conflicting agent identity');
    if (intent.agentOpenfortAccountId && intent.agentOpenfortAccountId !== input.accountId) throw new Error('Intent already assigned to another provider account');
    if ((intent.agentWalletAddress && intent.agentWalletAddress.toLowerCase() !== address.toLowerCase()) ||
        (intent.agentKeyHash && intent.agentKeyHash.toLowerCase() !== hash.toLowerCase())) throw new Error('Intent has conflicting provider identity');
    const otherWallet = await tx.userWallet.findFirst({ where: { id: { not: input.walletId }, OR: [
      { agentOpenfortAccountId: input.accountId }, { agentWalletAddress: { equals: address, mode: 'insensitive' } },
    ] }, select: { id: true } });
    const otherIntent = await tx.walletProvisioningIntent.findFirst({ where: { walletId: { not: input.walletId }, OR: [
      { agentOpenfortAccountId: input.accountId }, { agentWalletAddress: { equals: address, mode: 'insensitive' } },
    ] }, select: { walletId: true } });
    if (otherWallet || otherIntent) throw new Error('Provider account or address is already assigned elsewhere');
    const now = new Date();
    const updated = await tx.walletProvisioningIntent.updateMany({
      where: { walletId: input.walletId, dispatchToken: input.dispatchToken, status: intent.status },
      data: { status: 'provisioned', agentOpenfortAccountId: input.accountId, agentWalletAddress: address, agentKeyHash: hash,
        resolution: 'operator_bound', resolutionDetails: `operator=${input.operator}; evidence=${input.evidence}`.slice(0, 1000), resolvedAt: now },
    });
    if (updated.count !== 1) throw new Error('Intent compare-and-set failed');
    await tx.securityEvent.create({ data: { actorType: 'system', userId: wallet.userId, walletId: input.walletId,
      eventType: 'wallet.provisioning.recovered', riskLevel: 'medium', result: 'success', reason: 'operator_bound_existing_provider_account',
      metadata: { dispatchToken: intent.dispatchToken, originalStatus: intent.status, accountId: input.accountId, address,
        evidence: input.evidence, operator: input.operator } } });
  });
}
