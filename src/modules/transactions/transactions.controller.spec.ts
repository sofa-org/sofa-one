jest.mock('./transactions.service', () => ({
  TransactionsService: class TransactionsService {},
}));

import { TransactionsController } from './transactions.controller';

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
  });
});
