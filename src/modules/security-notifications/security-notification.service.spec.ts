import { SecurityNotificationService } from './security-notification.service';

describe('SecurityNotificationService', () => {
  const prisma = {
    securityNotification: {
      create: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
  };

  let service: SecurityNotificationService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SecurityNotificationService(prisma as never);
  });

  it('creates a dashboard notification for a user security event', async () => {
    prisma.securityNotification.create.mockResolvedValue({ id: 'notification-1' });

    await service.notifyForSecurityEvent({
      id: 'event-1',
      userId: 'user-1',
      eventType: 'api_key.created',
      riskLevel: 'low',
      reason: 'created',
    });

    expect(prisma.securityNotification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        securityEventId: 'event-1',
        type: 'api_key.created',
        title: 'New API key created',
        riskLevel: 'low',
        metadata: { eventType: 'api_key.created', reason: 'created' },
      }),
    });
  });

  it('does not notify system events without a user', async () => {
    await expect(
      service.notifyForSecurityEvent({
        id: 'event-1',
        userId: null,
        eventType: 'transaction.policy_denied',
        riskLevel: 'high',
      }),
    ).resolves.toBeNull();

    expect(prisma.securityNotification.create).not.toHaveBeenCalled();
  });

  it('does not notify low-risk events that are not user-facing alerts', async () => {
    await expect(
      service.notifyForSecurityEvent({
        id: 'event-1',
        userId: 'user-1',
        eventType: 'api_key.revoked',
        riskLevel: 'low',
      }),
    ).resolves.toBeNull();

    expect(prisma.securityNotification.create).not.toHaveBeenCalled();
  });

  it('uses the provided transaction client for notification writes', async () => {
    const tx = {
      securityNotification: { create: jest.fn().mockResolvedValue({ id: 'notification-2' }) },
    };

    await service.notifyForSecurityEvent(
      { id: 'event-2', userId: 'user-1', eventType: 'withdrawal.policy_denied', riskLevel: 'high' },
      tx as never,
    );

    expect(tx.securityNotification.create).toHaveBeenCalled();
    expect(prisma.securityNotification.create).not.toHaveBeenCalled();
  });

  it('lists user notifications with bounded limits', async () => {
    prisma.securityNotification.findMany.mockResolvedValue([{ id: 'notification-1' }]);

    await expect(service.listForUser('user-1', { unreadOnly: true, limit: 500 })).resolves.toEqual([
      { id: 'notification-1' },
    ]);

    expect(prisma.securityNotification.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', readAt: null },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  });

  it('marks one or all notifications as read for the owning user', async () => {
    prisma.securityNotification.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 3 });

    await expect(service.markRead('user-1', 'notification-1')).resolves.toEqual({
      success: true,
      updatedCount: 1,
    });
    await expect(service.markAllRead('user-1')).resolves.toEqual({
      success: true,
      updatedCount: 3,
    });

    expect(prisma.securityNotification.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'notification-1', userId: 'user-1', readAt: null },
      data: { readAt: expect.any(Date) },
    });
    expect(prisma.securityNotification.updateMany).toHaveBeenNthCalledWith(2, {
      where: { userId: 'user-1', readAt: null },
      data: { readAt: expect.any(Date) },
    });
  });
});
