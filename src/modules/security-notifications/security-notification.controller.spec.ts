import { GUARDS_METADATA } from '@nestjs/common/constants';

jest.mock('../../common/guards/frontend-only.guard', () => ({
  FrontendOnlyGuard: class FrontendOnlyGuard {},
}));
jest.mock('../../common/guards/openfort-user.guard', () => ({
  OpenfortUserGuard: class OpenfortUserGuard {},
}));

import { SecurityNotificationController } from './security-notification.controller';
import { SecurityNotificationService } from './security-notification.service';
import { IS_FRONTEND_ONLY_KEY } from '../../common/decorators/frontend-only.decorator';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';
import { OpenfortUserGuard } from '../../common/guards/openfort-user.guard';

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

  it('uses frontend-only user guards at the class level', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, SecurityNotificationController) ?? [];

    expect(guards).toContain(OpenfortUserGuard);
    expect(guards).toContain(FrontendOnlyGuard);
    expect(Reflect.getMetadata(IS_FRONTEND_ONLY_KEY, SecurityNotificationController)).toBe(true);
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
