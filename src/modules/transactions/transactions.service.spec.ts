import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';

jest.mock('../../core/openfort/openfort.service', () => ({
  OpenfortService: class OpenfortService {},
}));

import { TransactionsService } from './transactions.service';

describe('TransactionsService', () => {
  const apiKeyPrefix = 'sk_1234567890abcdef12345678';
  const wallet = {
    openfortAccountId: 'acc-1',
    walletAddress: '0xABCDEF1234567890ABCDEf1234567890abcdef12',
    agentOpenfortAccountId: 'agent-acc-1',
    agentWalletAddress: '0x2222222222222222222222222222222222222222',
    agentKeyHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
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
    keyPrefix: apiKeyPrefix,
    name: 'Production key',
    allowedChains: [8453],
  };

  const prisma = {
    userWallet: { findUnique: jest.fn() },
    userPolicy: { findUnique: jest.fn() },
    transaction: {
      create: jest.fn(),
      update: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
  } as any;

  const openfort = { sendUserOperation: jest.fn() } as any;

  let service: TransactionsService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.userWallet.findUnique.mockResolvedValue(wallet);
    prisma.userPolicy.findUnique.mockResolvedValue({ id: 'link-1' });
    prisma.transaction.findFirst.mockResolvedValue(null);
    prisma.transaction.create.mockResolvedValue({
      id: 'tx-1',
      status: 'submitting',
      txHash: null,
    });
    prisma.transaction.update.mockResolvedValue({
      id: 'tx-1',
      status: 'confirmed',
      txHash: '0xhash',
    });
    openfort.sendUserOperation.mockResolvedValue({
      userOpHash: '0xuserop',
      transactionHash: '0xhash',
    });
    service = new TransactionsService(prisma, openfort);
  });

  it('uses requested chainId and creates idempotency record before sending', async () => {
    await service.send('user-1', dto as any, apiKeyContext);

    expect(prisma.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        apiKeyId: 'api-key-1',
        authMethod: 'api_key',
        apiKeyPrefix,
        apiKeyName: 'Production key',
        status: 'submitting',
        chainId: BigInt(8453),
        operationType: 'send',
        idempotencyKey: 'idem-1',
        requestHash: expect.any(String),
        details: expect.objectContaining({
          type: 'send',
          interactionCount: 1,
          requestHash: expect.any(String),
        }),
      }),
    });
    expect(prisma.transaction.create.mock.calls[0][0].data.details).not.toHaveProperty(
      'interactions',
    );
    expect(openfort.sendUserOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: 8453,
        accountAddress: wallet.walletAddress,
        agentAccountId: wallet.agentOpenfortAccountId,
        keyHash: wallet.agentKeyHash,
      }),
    );
  });

  it('rejects bearer-token transaction submission before loading the wallet', async () => {
    await expect(service.send('user-1', dto as any)).rejects.toThrow(UnauthorizedException);

    expect(prisma.userWallet.findUnique).not.toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('returns existing transaction on idempotency collision without resending', async () => {
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-existing',
      status: 'pending',
      txHash: null,
    });

    const result = await service.send('user-1', dto as any, apiKeyContext);

    expect(result).toEqual({
      transactionId: 'tx-existing',
      transactionHash: null,
      status: 'pending',
    });
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('returns an in-progress transaction on idempotency collision without resending', async () => {
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-existing',
      status: 'submitting',
      txHash: null,
    });

    const result = await service.send('user-1', dto as any, apiKeyContext);

    expect(result).toEqual({
      transactionId: 'tx-existing',
      transactionHash: null,
      status: 'submitting',
    });
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('returns an existing policy transaction before policy lookup or Openfort send', async () => {
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-existing',
      status: 'pending',
      txHash: null,
    });

    const result = await service.send(
      'user-1',
      { ...dto, policyId: 'policy-deleted-after-first-submit' } as any,
      apiKeyContext,
    );

    expect(result).toEqual({
      transactionId: 'tx-existing',
      transactionHash: null,
      status: 'pending',
    });
    expect(prisma.userPolicy.findUnique).not.toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('returns the existing transaction after a concurrent idempotency insert race', async () => {
    prisma.transaction.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'tx-existing',
      status: 'submitting',
      txHash: null,
    });
    prisma.transaction.create.mockRejectedValue({ code: 'P2002' });

    const result = await service.send('user-1', dto as any, apiKeyContext);

    expect(result).toEqual({
      transactionId: 'tx-existing',
      transactionHash: null,
      status: 'submitting',
    });
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it.each([
    {
      status: 'confirmed',
      txHash: '0xconfirmed',
      expectedHash: '0xconfirmed',
    },
    { status: 'failed', txHash: null, expectedHash: null },
  ])(
    'returns existing $status transaction on idempotency collision without resending',
    async ({ status, txHash, expectedHash }) => {
      prisma.transaction.findFirst.mockResolvedValue({
        id: 'tx-existing',
        status,
        txHash,
      });

      const result = await service.send('user-1', dto as any, apiKeyContext);

      expect(result).toEqual({
        transactionId: 'tx-existing',
        transactionHash: expectedHash,
        status,
      });
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(openfort.sendUserOperation).not.toHaveBeenCalled();
    },
  );

  it('rejects API keys that are not allowed to use the requested chain', async () => {
    await expect(
      service.send('user-1', dto as any, { ...apiKeyContext, allowedChains: [84532] }),
    ).rejects.toThrow(BadRequestException);
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('rejects idempotency key reuse with a different request on the same chain', async () => {
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-existing',
      status: 'pending',
      txHash: null,
      requestHash: 'different-request',
    });

    await expect(service.send('user-1', dto as any, apiKeyContext)).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('rejects unowned policyId', async () => {
    prisma.userPolicy.findUnique.mockResolvedValue(null);

    await expect(
      service.send('user-1', { ...dto, policyId: 'pol-2' } as any, apiKeyContext),
    ).rejects.toThrow(NotFoundException);
    expect(openfort.sendUserOperation).not.toHaveBeenCalled();
  });

  it('marks transaction failed and stores summarized failure reason when Openfort submission fails', async () => {
    openfort.sendUserOperation.mockRejectedValue(new Error('Openfort rejected transaction'));

    await expect(service.send('user-1', dto as any, apiKeyContext)).rejects.toThrow(
      'Openfort rejected transaction',
    );

    expect(prisma.transaction.update).toHaveBeenCalledWith({
      where: { id: 'tx-1' },
      data: expect.objectContaining({
        status: 'failed',
        failureReason: 'Openfort rejected transaction',
        completedAt: expect.any(Date),
      }),
    });
  });

  it('stores pending status when transaction hash is not available yet', async () => {
    openfort.sendUserOperation.mockResolvedValue({ userOpHash: '0xuserop', transactionHash: null });
    prisma.transaction.update.mockResolvedValue({
      id: 'tx-1',
      status: 'pending',
      txHash: null,
    });

    await expect(service.send('user-1', dto as any, apiKeyContext)).resolves.toEqual({
      transactionId: 'tx-1',
      transactionHash: null,
      status: 'pending',
    });
    expect(prisma.transaction.update).toHaveBeenCalledWith({
      where: { id: 'tx-1' },
      data: expect.objectContaining({
        txHash: null,
        status: 'pending',
      }),
    });
  });

  it('returns a safe status response for an owned transaction', async () => {
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-1',
      userId: 'user-1',
      status: 'confirmed',
      txHash: '0xhash',
      chainId: BigInt(8453),
      walletAddress: wallet.walletAddress,
      failureReason: null,
      createdAt: new Date('2026-04-28T00:00:00.000Z'),
      completedAt: new Date('2026-04-28T00:01:00.000Z'),
    });

    await expect(service.getStatus('user-1', 'tx-1', apiKeyContext)).resolves.toEqual({
      transactionId: 'tx-1',
      transactionHash: '0xhash',
      status: 'confirmed',
      chainId: 8453,
      walletAddress: wallet.walletAddress,
      failureReason: null,
      createdAt: new Date('2026-04-28T00:00:00.000Z'),
      completedAt: new Date('2026-04-28T00:01:00.000Z'),
    });
  });

  it('returns stored pending status without Openfort status refresh', async () => {
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-1',
      status: 'pending',
      txHash: null,
      chainId: BigInt(8453),
      walletAddress: wallet.walletAddress,
      failureReason: null,
      createdAt: new Date('2026-04-28T00:00:00.000Z'),
      completedAt: null,
    });

    await expect(service.getStatus('user-1', 'tx-1', apiKeyContext)).resolves.toEqual(
      expect.objectContaining({ status: 'pending', transactionHash: null }),
    );
  });

  it('does not expose transactions owned by another user', async () => {
    prisma.transaction.findFirst.mockResolvedValue(null);

    await expect(service.getStatus('user-1', 'tx-other', apiKeyContext)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('rejects status lookup when the API key is not allowed on the transaction chain', async () => {
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-1',
      status: 'confirmed',
      txHash: '0xhash',
      chainId: BigInt(8453),
      walletAddress: wallet.walletAddress,
    });

    await expect(
      service.getStatus('user-1', 'tx-1', { ...apiKeyContext, allowedChains: [84532] }),
    ).rejects.toThrow(BadRequestException);
  });
});
