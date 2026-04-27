import { NotFoundException } from '@nestjs/common';

jest.mock('../../core/openfort/openfort.service', () => ({
  OpenfortService: class OpenfortService {},
}));

import { TransactionsService } from './transactions.service';

describe('TransactionsService.send()', () => {
  const wallet = {
    openfortAccountId: 'acc-1',
    walletAddress: '0xABCDEF1234567890ABCDEf1234567890abcdef12',
    chainId: BigInt(84532),
    status: 'active',
  };

  const dto = {
    interactions: [{ to: '0x1111111111111111111111111111111111111111', data: '0x', value: '0' }],
    idempotencyKey: 'idem-1',
  };

  const prisma = {
    userWallet: { findUnique: jest.fn() },
    userPolicy: { findUnique: jest.fn() },
    transaction: { create: jest.fn(), update: jest.fn(), findFirst: jest.fn() },
  } as any;

  const openfort = { sendTransaction: jest.fn() } as any;

  let service: TransactionsService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.userWallet.findUnique.mockResolvedValue(wallet);
    prisma.userPolicy.findUnique.mockResolvedValue({ id: 'link-1' });
    prisma.transaction.create.mockResolvedValue({ id: 'tx-1', status: 'submitting', intentId: null, txHash: null });
    prisma.transaction.update.mockResolvedValue({ id: 'tx-1', status: 'confirmed', txHash: '0xhash' });
    openfort.sendTransaction.mockResolvedValue({ transactionHash: '0xhash' });
    service = new TransactionsService(prisma, openfort);
  });

  it('derives chainId from wallet and creates idempotency record before sending', async () => {
    await service.send('user-1', dto as any);

    expect(prisma.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        status: 'submitting',
        chainId: BigInt(84532),
        operationType: 'send',
        idempotencyKey: 'idem-1',
      }),
    });
    expect(openfort.sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ chainId: 84532 }));
  });

  it('returns existing transaction on idempotency collision without resending', async () => {
    prisma.transaction.create.mockRejectedValue({ code: 'P2002' });
    prisma.transaction.findFirst.mockResolvedValue({ id: 'tx-existing', status: 'pending', intentId: null, txHash: null });

    const result = await service.send('user-1', dto as any);

    expect(result).toEqual({ transactionId: 'tx-existing', transactionHash: null, status: 'pending' });
    expect(openfort.sendTransaction).not.toHaveBeenCalled();
  });

  it('rejects unowned policyId', async () => {
    prisma.userPolicy.findUnique.mockResolvedValue(null);

    await expect(service.send('user-1', { ...dto, policyId: 'pol-2' } as any)).rejects.toThrow(NotFoundException);
    expect(openfort.sendTransaction).not.toHaveBeenCalled();
  });
});
