import { BillingWalletLifecycleService } from './billing-wallet-lifecycle.service';

describe('BillingWalletLifecycleService', () => {
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    billingAccount: { findUniqueOrThrow: jest.fn(), update: jest.fn() },
    billingWalletUsagePeriod: { findUnique: jest.fn(), upsert: jest.fn() },
    userWallet: { count: jest.fn(), findMany: jest.fn() },
    walletProvisioningIntent: { findMany: jest.fn() },
  };
  const prisma: any = {
    billingAccount: { upsert: jest.fn() },
    $transaction: jest.fn(),
  };
  const entitlements: any = { getEntitlementsInTransaction: jest.fn() };
  let service: BillingWalletLifecycleService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new BillingWalletLifecycleService(prisma, entitlements);
    prisma.billingAccount.upsert.mockResolvedValue({ id: 'acct' });
    prisma.$transaction.mockImplementation(async (cb: any) => cb(tx));
    entitlements.getEntitlementsInTransaction.mockResolvedValue({ includedWallets: 2, effectivePeriod: '2026-09' });
    tx.walletProvisioningIntent.findMany.mockResolvedValue([]);
    tx.userWallet.findMany.mockResolvedValue([]);
    tx.userWallet.count.mockResolvedValue(1);
    tx.billingAccount.findUniqueOrThrow.mockResolvedValue({ eligibleWalletCount: 1, walletCountObservedAt: new Date('2026-07-15T00:00:00Z') });
    tx.billingWalletUsagePeriod.findUnique.mockResolvedValue(null);
    tx.billingWalletUsagePeriod.upsert.mockResolvedValue({});
    tx.billingAccount.update.mockResolvedValue({});
  });

  it('creates account before transaction and locks before callback work', async () => {
    const events: string[] = [];
    prisma.billingAccount.upsert.mockImplementation(async () => { events.push('ensure'); return { id: 'acct' }; });
    prisma.$transaction.mockImplementation(async (cb: any) => { events.push('transaction'); return cb(tx); });
    tx.$queryRaw.mockImplementation(async () => { events.push('lock'); return []; });
    await service.withWalletAccountLock('user', async () => { events.push('callback'); return 1; });
    expect(events).toEqual(['ensure', 'transaction', 'lock', 'callback']);
  });

  it('prepares zero baseline and captures observation time only after the row lock', async () => {
    const now = new Date('2026-09-12T12:00:00Z');
    const RealDate = Date;
    let locked = false;
    tx.$queryRaw.mockImplementation(async () => { locked = true; return []; });
    const dateSpy = jest.spyOn(global, 'Date').mockImplementation((...args: any[]) => {
      if (args.length) return new RealDate(args[0]) as any;
      expect(locked).toBe(true);
      return now as any;
    });
    (global.Date as any).UTC = RealDate.UTC;
    tx.billingAccount.findUniqueOrThrow
      .mockResolvedValueOnce({ eligibleWalletCount: 0, walletCountObservedAt: null })
      .mockResolvedValueOnce({ eligibleWalletCount: 0, walletCountObservedAt: now });
    tx.userWallet.count.mockResolvedValue(0);
    try { await service.prepareWalletUsageThroughCurrentMonth('user'); } finally { dateSpy.mockRestore(); }
    expect(tx.billingWalletUsagePeriod.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ peakWalletCount: 0, periodStart: new RealDate('2026-09-01T00:00:00Z') }),
    }));
    expect(tx.billingAccount.update).toHaveBeenCalledWith(expect.objectContaining({ data: { eligibleWalletCount: 0, walletCountObservedAt: now } }));
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.calls[0][0].join('')).not.toContain('advisory');
  });

  it('carries an observed peak monotonically across idle months and is idempotent', async () => {
    const now = new Date('2026-09-12T12:00:00Z');
    jest.useFakeTimers().setSystemTime(now);
    tx.billingAccount.findUniqueOrThrow.mockResolvedValue({ eligibleWalletCount: 3, walletCountObservedAt: new Date('2026-06-20T00:00:00Z') });
    tx.billingWalletUsagePeriod.findUnique.mockResolvedValue({ peakWalletCount: 5 });
    try {
      await service.prepareWalletUsageThroughCurrentMonth('user');
      const writes = tx.billingWalletUsagePeriod.upsert.mock.calls.map(([arg]: any[]) => arg);
      expect(writes.map((w: any) => w.create.periodStart.toISOString())).toEqual([
        '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z',
      ]);
      expect(writes.every((w: any) => w.create.peakWalletCount === 3)).toBe(true);
      expect(writes.every((w: any) => w.update.peakWalletCount === 5)).toBe(true);
      expect(tx.billingAccount.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: { walletCountObservedAt: now } }));
    } finally { jest.useRealTimers(); }
  });

  it('counts provisioned reservations once and rejects a full quota reservation', async () => {
    tx.walletProvisioningIntent.findMany.mockResolvedValue([
      { walletId: 'w1' }, { walletId: 'w2' },
    ]);
    tx.userWallet.findMany.mockResolvedValue([{ id: 'w1' }]);
    await expect(service.assertWalletReservationAllowed(tx, 'user', 'w3', new Date('2026-09-10Z')))
      .rejects.toThrow('quota exceeded');
  });

  it('rejects a new activation above a downgraded cap despite a larger stale account count', async () => {
    entitlements.getEntitlementsInTransaction.mockResolvedValue({ includedWallets: 1, effectivePeriod: '2026-09' });
    // One previously eligible wallet and the just-activated wallet. The account
    // baseline is deliberately stale/high and must not grandfather this transition.
    tx.userWallet.findMany.mockResolvedValue([{ id: 'old-wallet' }, { id: 'new-wallet' }]);
    tx.userWallet.count.mockResolvedValue(2);
    tx.billingAccount.findUniqueOrThrow.mockResolvedValue({ eligibleWalletCount: 10, walletCountObservedAt: new Date('2026-07-15T00:00:00Z') });
    await expect(service.recordWalletActivation(tx, 'acct', 'user', new Date('2026-09-10T00:00:00Z')))
      .rejects.toThrow('quota exceeded');
    expect(tx.billingWalletUsagePeriod.upsert).not.toHaveBeenCalled();
  });

  it('carries prior observed count through idle months before applying the new peak', async () => {
    const now = new Date('2026-09-12T12:00:00Z');
    tx.userWallet.count.mockResolvedValue(2);
    await service.recordWalletActivation(tx, 'acct', 'user', now);
    const writes = tx.billingWalletUsagePeriod.upsert.mock.calls.map(([arg]: any[]) => arg);
    expect(writes.map((w: any) => w.create.periodStart.toISOString())).toEqual([
      '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z',
    ]);
    expect(writes[0].create.peakWalletCount).toBe(1);
    expect(writes[1].create.peakWalletCount).toBe(1);
    expect(writes[2].create.peakWalletCount).toBe(2);
    expect(tx.billingAccount.update).toHaveBeenCalledWith(expect.objectContaining({ data: { eligibleWalletCount: 2, walletCountObservedAt: now } }));
  });

  it('initializes an unobserved legacy account from actual active wallets without activation quota checks', async () => {
    const now = new Date('2026-09-12T12:00:00Z');
    tx.billingAccount.findUniqueOrThrow.mockResolvedValue({ eligibleWalletCount: 0, walletCountObservedAt: null });
    tx.userWallet.count.mockResolvedValue(1);
    await service.initializeWalletCount(tx, 'acct', 'user', now);
    expect(tx.billingWalletUsagePeriod.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ peakWalletCount: 1, observedAt: now }),
    }));
    expect(tx.billingAccount.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { eligibleWalletCount: 1, walletCountObservedAt: now },
    }));
    expect(entitlements.getEntitlementsInTransaction).not.toHaveBeenCalled();
  });

  it('does not write peak evidence when activation callback work fails and propagates the error', async () => {
    const failure = new Error('wallet update failed');
    const committedPeaks: unknown[] = [];
    const pendingPeaks: unknown[] = [];
    tx.billingWalletUsagePeriod.upsert.mockImplementation(async (args: unknown) => { pendingPeaks.push(args); return {}; });
    prisma.$transaction.mockImplementation(async (cb: any) => {
      try {
        const result = await cb(tx);
        committedPeaks.push(...pendingPeaks);
        return result;
      } catch (error) {
        pendingPeaks.length = 0;
        throw error;
      }
    });
    await expect(prisma.$transaction(async (client: any) => {
      await service.recordWalletActivation(client, 'acct', 'user', new Date('2026-09-10Z'));
      throw failure;
    })).rejects.toBe(failure);
    expect(committedPeaks).toEqual([]);
    expect(tx.billingWalletUsagePeriod.upsert).toHaveBeenCalled();
  });
});
