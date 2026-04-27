import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';

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
    chainId: 8453,
    interactions: [{ to: '0x1111111111111111111111111111111111111111', data: '0x', value: '0' }],
    idempotencyKey: 'idem-1',
  };

  const apiKeyContext = {
    id: 'api-key-1',
    keyPrefix: 'sk_test1234',
    name: 'Production key',
    allowedChains: [8453],
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

  it('uses requested chainId and creates idempotency record before sending', async () => {
    await service.send('user-1', dto as any, apiKeyContext);

    expect(prisma.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        apiKeyId: 'api-key-1',
        authMethod: 'api_key',
        apiKeyPrefix: 'sk_test1234',
        apiKeyName: 'Production key',
        status: 'submitting',
        chainId: BigInt(8453),
        operationType: 'send',
        idempotencyKey: 'idem-1',
        requestHash: expect.any(String),
        interactionsHash: expect.any(String),
        details: expect.objectContaining({
          type: 'send',
          interactionCount: 1,
          interactionsHash: expect.any(String),
          requestHash: expect.any(String),
        }),
      }),
    });
    expect(prisma.transaction.create.mock.calls[0][0].data.details).not.toHaveProperty('interactions');
    expect(openfort.sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ chainId: 8453 }));
  });

  it('rejects Clerk-authenticated transaction submission before loading the wallet', async () => {
    await expect(service.send('user-1', dto as any)).rejects.toThrow(UnauthorizedException);

    expect(prisma.userWallet.findUnique).not.toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendTransaction).not.toHaveBeenCalled();
  });

  it('returns existing transaction on idempotency collision without resending', async () => {
    prisma.transaction.create.mockRejectedValue({ code: 'P2002' });
    prisma.transaction.findFirst.mockResolvedValue({ id: 'tx-existing', status: 'pending', intentId: null, txHash: null });

    const result = await service.send('user-1', dto as any, apiKeyContext);

    expect(result).toEqual({ transactionId: 'tx-existing', transactionHash: null, status: 'pending' });
    expect(openfort.sendTransaction).not.toHaveBeenCalled();
  });

  it('returns an in-progress transaction on idempotency collision without resending', async () => {
    prisma.transaction.create.mockRejectedValue({ code: 'P2002' });
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-existing',
      status: 'submitting',
      intentId: null,
      txHash: null,
    });

    const result = await service.send('user-1', dto as any, apiKeyContext);

    expect(result).toEqual({ transactionId: 'tx-existing', transactionHash: null, status: 'submitting' });
    expect(openfort.sendTransaction).not.toHaveBeenCalled();
  });

  it('rejects API keys that are not allowed to use the requested chain', async () => {
    await expect(service.send('user-1', dto as any, { ...apiKeyContext, allowedChains: [84532] })).rejects.toThrow(
      BadRequestException,
    );
    expect(openfort.sendTransaction).not.toHaveBeenCalled();
  });

  it('rejects idempotency key reuse with a different request on the same chain', async () => {
    prisma.transaction.create.mockRejectedValue({ code: 'P2002' });
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-existing',
      status: 'pending',
      intentId: null,
      txHash: null,
      requestHash: 'different-request',
    });

    await expect(service.send('user-1', dto as any, apiKeyContext)).rejects.toThrow(BadRequestException);
    expect(openfort.sendTransaction).not.toHaveBeenCalled();
  });

  it('rejects unowned policyId', async () => {
    prisma.userPolicy.findUnique.mockResolvedValue(null);

    await expect(service.send('user-1', { ...dto, policyId: 'pol-2' } as any, apiKeyContext)).rejects.toThrow(NotFoundException);
    expect(openfort.sendTransaction).not.toHaveBeenCalled();
  });

  it('marks transaction failed and stores summarized failure reason when Openfort submission fails', async () => {
    openfort.sendTransaction.mockRejectedValue(new Error('Openfort rejected transaction'));

    await expect(service.send('user-1', dto as any, apiKeyContext)).rejects.toThrow('Openfort rejected transaction');

    expect(prisma.transaction.update).toHaveBeenCalledWith({
      where: { id: 'tx-1' },
      data: expect.objectContaining({
        status: 'failed',
        failureReason: 'Openfort rejected transaction',
        completedAt: expect.any(Date),
      }),
    });
  });
});
