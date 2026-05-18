import { GUARDS_METADATA } from '@nestjs/common/constants';

jest.mock('./transactions.service', () => ({
  TransactionsService: class TransactionsService {},
}));
jest.mock('../../core/openfort/openfort.service', () => ({
  OpenfortService: class OpenfortService {},
}));
jest.mock('../../common/guards/either-auth.guard', () => ({
  EitherAuthGuard: class EitherAuthGuard {},
}));
jest.mock('../../common/guards/api-key-only.guard', () => ({
  ApiKeyOnlyGuard: class ApiKeyOnlyGuard {},
}));
jest.mock('../../common/guards/frontend-only.guard', () => ({
  FrontendOnlyGuard: class FrontendOnlyGuard {},
}));

import { TransactionsController } from './transactions.controller';
import { EitherAuthGuard } from '../../common/guards/either-auth.guard';
import { ApiKeyOnlyGuard } from '../../common/guards/api-key-only.guard';
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

  it('uses EitherAuthGuard at the class level', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, TransactionsController) ?? [];

    expect(guards).toContain(EitherAuthGuard);
  });

  describe('send', () => {
    it('delegates to transactionsService.send with userId, dto, and apiKeyRecord', async () => {
      const dto = { to: '0xabc', data: '0x', chainId: 84532 };
      const apiKeyRecord = { id: 'key-1' };
      const req = { apiKeyRecord };
      transactionsService.send.mockResolvedValue({ id: 'tx-1', status: 'pending' });

      const result = await controller.send('user-1', dto as any, req as any);

      expect(transactionsService.send).toHaveBeenCalledWith('user-1', dto, apiKeyRecord);
      expect(result).toEqual({ id: 'tx-1', status: 'pending' });
    });

    it('is api-key only and not frontend-only', () => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, controller.send) ?? [];

      expect(guards).toContain(ApiKeyOnlyGuard);
      expect(guards).not.toContain(FrontendOnlyGuard);
      expect(Reflect.getMetadata(IS_FRONTEND_ONLY_KEY, controller.send)).toBeUndefined();
    });
  });

  describe('getStatus', () => {
    it('delegates to transactionsService.getStatus with userId, txId, and apiKeyRecord', async () => {
      const txId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
      const apiKeyRecord = { id: 'key-1' };
      const req = { apiKeyRecord };
      transactionsService.getStatus.mockResolvedValue({ id: txId, status: 'completed' });

      const result = await controller.getStatus('user-1', txId, req as any);

      expect(transactionsService.getStatus).toHaveBeenCalledWith('user-1', txId, apiKeyRecord);
      expect(result).toEqual({ id: txId, status: 'completed' });
    });

    it('is api-key only and not frontend-only', () => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, controller.getStatus) ?? [];

      expect(guards).toContain(ApiKeyOnlyGuard);
      expect(guards).not.toContain(FrontendOnlyGuard);
      expect(Reflect.getMetadata(IS_FRONTEND_ONLY_KEY, controller.getStatus)).toBeUndefined();
    });
  });
});
