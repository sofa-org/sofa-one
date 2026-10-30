import { PolymarketSigningBudgetService } from './polymarket-signing-budget.service';

describe('PolymarketSigningBudgetService', () => {
  const dbNow = new Date('2026-10-09T12:00:00.000Z');
  const tx = { $executeRaw: jest.fn(), $queryRaw: jest.fn(), securityEvent: { count: jest.fn(), findFirst: jest.fn() } } as any;
  const events = { record: jest.fn(), exportCommitted: jest.fn() } as any;
  let service: PolymarketSigningBudgetService;
  beforeEach(() => {
    jest.clearAllMocks();
    tx.securityEvent.count.mockResolvedValue(0);
    tx.$queryRaw.mockResolvedValue([{ now: dbNow }]);
    events.record.mockResolvedValue({ id: 'event' });
    service = new PolymarketSigningBudgetService(events);
  });

  it('acquires wallet lock before counting, then records accepted event in transaction', async () => {
    await service.acquireWalletLock(tx, 'wallet-a');
    await service.recordAcceptedInTransaction(tx, { walletId: 'wallet-a', userId: 'user', apiKeyId: 'key' });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.securityEvent.count).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ walletId: 'wallet-a', eventType: 'polymarket_order_signing_accepted' }) }));
    expect(events.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'polymarket_order_signing_accepted', walletId: 'wallet-a' }), tx, { deferExport: true });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(events.record.mock.calls[0][0].createdAt).toBe(dbNow);
    expect(tx.securityEvent.count.mock.calls[0][0].where.createdAt.gt).toEqual(new Date(dbNow.getTime() - 60_000));
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.$queryRaw.mock.invocationCallOrder[0]);
  });

  it('rejects once the per-wallet rolling window has 60 accepted orders', async () => {
    tx.securityEvent.count.mockResolvedValue(60);
    tx.securityEvent.findFirst.mockResolvedValue({ createdAt: new Date(Date.now() - 10_000) });
    await expect(service.recordAcceptedInTransaction(tx, { walletId: 'wallet-a', userId: 'user', apiKeyId: 'key' })).rejects.toMatchObject({
      status: 429,
      response: expect.objectContaining({ code: 'POLYMARKET_SIGN_RATE_LIMITED', retryAfterSeconds: expect.any(Number) }),
    });
    expect(events.record).not.toHaveBeenCalled();
  });
});
