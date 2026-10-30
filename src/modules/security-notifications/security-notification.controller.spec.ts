jest.mock('../../common/guards/frontend-only.guard', () => ({
  FrontendOnlyGuard: class FrontendOnlyGuard {},
}));
jest.mock('../../common/guards/app-session.guard', () => ({ AppSessionGuard: class AppSessionGuard {} }));

import { SecurityNotificationController } from './security-notification.controller';
import { SecurityNotificationService } from './security-notification.service';

describe('SecurityNotificationController', () => {
  const notifications = {
    listForUser: jest.fn(),
    markRead: jest.fn(),
    markAllRead: jest.fn(),
  };
  let controller: SecurityNotificationController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new SecurityNotificationController(notifications as unknown as SecurityNotificationService);
  });


  it('delegates list with parsed query values', async () => {
    notifications.listForUser.mockResolvedValue([{ id: 'notification-1' }]);

    await expect(controller.list('user-1', 'true', '5')).resolves.toEqual([
      { id: 'notification-1' },
    ]);

    expect(notifications.listForUser).toHaveBeenCalledWith('user-1', {
      unreadOnly: true,
      limit: 5,
    });
  });

  it('delegates mark-read operations', async () => {
    notifications.markRead.mockResolvedValue({ success: true, updatedCount: 1 });
    notifications.markAllRead.mockResolvedValue({ success: true, updatedCount: 2 });

    await expect(controller.markRead('user-1', 'notification-1')).resolves.toEqual({
      success: true,
      updatedCount: 1,
    });
    await expect(controller.markAllRead('user-1')).resolves.toEqual({
      success: true,
      updatedCount: 2,
    });

    expect(notifications.markRead).toHaveBeenCalledWith('user-1', 'notification-1');
    expect(notifications.markAllRead).toHaveBeenCalledWith('user-1');
  });
});
