import { GUARDS_METADATA } from '@nestjs/common/constants';

jest.mock('./transactions.service', () => ({
  TransactionsService: class TransactionsService {},
}));
jest.mock('../../core/openfort/openfort.service', () => ({
  OpenfortService: class OpenfortService {},
}));
jest.mock('../../common/guards/api-key-auth.guard', () => ({
  ApiKeyAuthGuard: class ApiKeyAuthGuard {},
}));
jest.mock('../../common/guards/api-key-permission.guard', () => ({
  ApiKeyPermissionGuard: class ApiKeyPermissionGuard {},
}));
jest.mock('../../common/guards/frontend-only.guard', () => ({
  FrontendOnlyGuard: class FrontendOnlyGuard {},
}));

import { TransactionsController } from './transactions.controller';
import { ApiKeyAuthGuard } from '../../common/guards/api-key-auth.guard';
import { ApiKeyPermissionGuard } from '../../common/guards/api-key-permission.guard';
import { API_KEY_PERMISSION_KEY } from '../../common/decorators/api-key-permission.decorator';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';
import { IS_FRONTEND_ONLY_KEY } from '../../common/decorators/frontend-only.decorator';

describe('TransactionsController', () => {
  const transactionsService = {
    send: jest.fn(),
    getStatus: jest.fn(),
  };

  let controller: TransactionsController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new TransactionsController(transactionsService as any);
  });

  it('does not use a class-level auth guard', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, TransactionsController) ?? [];

    expect(guards).toEqual([]);
  });

  describe('send', () => {

    it('is api-key only and not frontend-only', () => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, controller.send) ?? [];

      expect(guards).toContain(ApiKeyAuthGuard);
      expect(guards).toContain(ApiKeyPermissionGuard);
      expect(Reflect.getMetadata(API_KEY_PERMISSION_KEY, controller.send)).toBe(
        'canSendTransaction',
      );
      expect(guards).not.toContain(FrontendOnlyGuard);
      expect(Reflect.getMetadata(IS_FRONTEND_ONLY_KEY, controller.send)).toBeUndefined();
    });
  });

  describe('getStatus', () => {

    it('is api-key only and not frontend-only', () => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, controller.getStatus) ?? [];

      expect(guards).toContain(ApiKeyAuthGuard);
      expect(guards).toContain(ApiKeyPermissionGuard);
      expect(Reflect.getMetadata(API_KEY_PERMISSION_KEY, controller.getStatus)).toBe(
        'canReadTransactionStatus',
      );
      expect(guards).not.toContain(FrontendOnlyGuard);
      expect(Reflect.getMetadata(IS_FRONTEND_ONLY_KEY, controller.getStatus)).toBeUndefined();
    });
  });

});
