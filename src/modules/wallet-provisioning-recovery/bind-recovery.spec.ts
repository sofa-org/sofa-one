import { bindProvisionedAccount, findRawProviderAccount } from './bind-recovery';

describe('bindProvisionedAccount', () => {
  const input = { walletId: 'wallet', dispatchToken: 'token', accountId: 'acct', operator: 'ops', evidence: 'TICKET-1' };
  const make = (intentStatus = 'uncertain', account: any = { id: 'acct', chainType: 'EVM', custody: 'Developer', address: '0x0000000000000000000000000000000000000001' }) => {
    const tx: any = {
      $queryRaw: jest.fn(),
      walletProvisioningIntent: { findUnique: jest.fn().mockResolvedValue({ walletId: 'wallet', dispatchToken: 'token', status: intentStatus, agentOpenfortAccountId: null }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      userWallet: { findUnique: jest.fn().mockResolvedValue({ id: 'wallet', userId: 'user', agentOpenfortAccountId: null }), findFirst: jest.fn().mockResolvedValue(null) },
      securityEvent: { create: jest.fn() },
    };
    tx.walletProvisioningIntent.findFirst = jest.fn().mockResolvedValue(null);
    const prisma = { userWallet: { findUnique: jest.fn().mockResolvedValue({ userId: 'user' }) }, billingAccount: { upsert: jest.fn().mockResolvedValue({ id: 'billing' }) }, $transaction: jest.fn(async (fn) => fn(tx)) };
    const provider = { getAccount: jest.fn().mockResolvedValue(account) };
    return { tx, prisma, provider };
  };

  it('rejects a mismatched provider account ID without transaction', async () => {
    const { prisma, provider } = make('uncertain', { id: 'different', chainType: 'EVM', custody: 'Developer', address: '0x0000000000000000000000000000000000000001' });
    await expect(bindProvisionedAccount(prisma, provider, () => 'hash', input)).rejects.toThrow();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects non-Developer custody without transaction', async () => {
    const { prisma, provider } = make('uncertain', { id: 'acct', chainType: 'EVM', custody: 'User', address: '0x0000000000000000000000000000000000000001' });
    await expect(bindProvisionedAccount(prisma, provider, () => 'hash', input)).rejects.toThrow();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not mutate on token/status mismatch', async () => {
    const { tx, prisma, provider } = make('pending');
    await expect(bindProvisionedAccount(prisma, provider, () => 'hash', input)).rejects.toThrow('Intent/token/status mismatch');
    expect(tx.walletProvisioningIntent.updateMany).not.toHaveBeenCalled();
    expect(tx.securityEvent.create).not.toHaveBeenCalled();
  });

  it('atomically CAS-binds and audits a verified account', async () => {
    const { tx, prisma, provider } = make();
    await bindProvisionedAccount(prisma, provider, () => 'hash', input);
    expect(tx.walletProvisioningIntent.updateMany).toHaveBeenCalled();
    expect(tx.userWallet.findFirst).toHaveBeenCalled();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.securityEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ metadata: expect.objectContaining({ originalStatus: 'uncertain', dispatchToken: 'token', operator: 'ops' }) }) }));
  });

  it('rejects partial conflicting identity and leaves intent unchanged', async () => {
    const { tx, prisma, provider } = make();
    tx.userWallet.findUnique.mockResolvedValue({ id: 'wallet', userId: 'user', agentOpenfortAccountId: null, agentWalletAddress: '0x0000000000000000000000000000000000000002', agentKeyHash: null });
    await expect(bindProvisionedAccount(prisma, provider, () => 'hash', input)).rejects.toThrow('conflicting agent identity');
    expect(tx.walletProvisioningIntent.updateMany).not.toHaveBeenCalled();
  });

  it('rolls back intent transition when audit append fails', async () => {
    const { tx, prisma, provider } = make();
    let committed = false;
    prisma.$transaction.mockImplementation(async (fn: any) => {
      try { await fn(tx); committed = true; } catch (error) { throw error; }
    });
    tx.securityEvent.create.mockRejectedValue(new Error('audit unavailable'));
    await expect(bindProvisionedAccount(prisma, provider, () => 'hash', input)).rejects.toThrow('audit unavailable');
    expect(committed).toBe(false);
  });

  it('does not append an audit when the database rejects a duplicate provider identity', async () => {
    const { tx, prisma, provider } = make();
    tx.walletProvisioningIntent.updateMany.mockRejectedValue(new Error('unique constraint violation'));
    await expect(bindProvisionedAccount(prisma, provider, () => 'hash', input)).rejects.toThrow('unique constraint violation');
    expect(tx.securityEvent.create).not.toHaveBeenCalled();
  });

  it('resolves only exact IDs from raw v2 account pages and rejects incomplete scans', async () => {
    const raw = { id: 'acct', address: '0x0000000000000000000000000000000000000001', chainType: 'EVM', custody: 'Developer' };
    const list = jest.fn().mockResolvedValue({ data: [raw], total: 1 });
    await expect(findRawProviderAccount(list, 'acct')).resolves.toEqual(raw);
    expect(list).toHaveBeenCalledWith({ chainType: 'EVM', custody: 'Developer', limit: 100, skip: 0 });
    await expect(findRawProviderAccount(list, 'wrong')).rejects.toThrow('not found');
    list.mockResolvedValue({ data: [], total: 1 });
    await expect(findRawProviderAccount(list, 'acct')).rejects.toThrow('truncated');
  });
});
