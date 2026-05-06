import { AuthService } from './auth.service';

jest.mock('../../core/openfort/openfort.service', () => ({
  OpenfortService: class {},
}));

describe('AuthService', () => {
  const chainId = 84532;
  const provisioningWallet = {
    id: 'wallet-1',
    userId: 'user-1',
    openfortAccountId: null,
    walletAddress: null,
    chainId: BigInt(chainId),
    status: 'pending_embedded_wallet',
  };

  let prisma: any;
  let openfort: any;
  let apiKeyService: any;
  let service: AuthService;

  beforeEach(() => {
    jest.clearAllMocks();

    const tx = {
      user: {
        create: jest.fn().mockResolvedValue({ id: 'user-1' }),
      },
      userWallet: {
        create: jest.fn().mockResolvedValue(provisioningWallet),
      },
    };

    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      userWallet: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
      },
      $transaction: jest.fn((callback) => callback(tx)),
      __tx: tx,
    };

    openfort = {
      createBackendWallet: jest.fn(),
      createAgentWallet: jest.fn(),
      authorizeEmbeddedAddress: jest.fn(),
      verifyAgentKeyRegistration: jest.fn(),
      getTransactionReceiptStatus: jest.fn(),
    };

    apiKeyService = {
      createApiKey: jest.fn().mockResolvedValue({ rawKey: 'sk_test' }),
    };

    const configService = {
      get: jest.fn((_key: string, fallback: unknown) => fallback),
      getOrThrow: jest.fn(() => 'secret'),
    };

    service = new AuthService(prisma, openfort, apiKeyService, configService as any);
  });

  it('creates a pending embedded-wallet record without creating a backend wallet', async () => {
    const result = await service.syncOpenfortSession('openfort-user-1', 'user@example.com');

    expect(prisma.__tx.userWallet.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        chainId: BigInt(chainId),
        status: 'pending_embedded_wallet',
      },
    });
    expect(openfort.createBackendWallet).not.toHaveBeenCalled();
    expect(prisma.userWallet.update).not.toHaveBeenCalled();
    expect(result).toEqual({
      userId: 'user-1',
      wallet: {
        walletAddress: null,
        embeddedWalletAddress: null,
        chainId,
        status: 'pending_embedded_wallet',
        supportedTokens: ['USDC', 'ETH'],
        agentWalletAddress: undefined,
        agentStatus: undefined,
        agentKeyHash: undefined,
        agentRegistrationTxHash: undefined,
        agentExpiresAt: null,
      },
    });
    expect(apiKeyService.createApiKey).not.toHaveBeenCalled();
  });

  it('does not issue an API key while embedded wallet binding is pending', async () => {
    await expect(service.syncOpenfortSession('openfort-user-1', 'user@example.com')).resolves.toMatchObject({
      userId: 'user-1',
      wallet: { walletAddress: null },
    });

    expect(prisma.__tx.userWallet.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        chainId: BigInt(chainId),
        status: 'pending_embedded_wallet',
      },
    });
    expect(apiKeyService.createApiKey).not.toHaveBeenCalled();
  });

  it('uses the requested Calibur agent expiry when authorizing an embedded wallet', async () => {
    const expiresAt = '2026-06-06T00:00:00.000Z';
    const wallet = {
      id: 'wallet-1',
      userId: 'user-1',
      openfortAccountId: 'embedded-account-1',
      status: 'active',
      chainId: BigInt(chainId),
      walletAddress: '0x1111111111111111111111111111111111111111',
      agentOpenfortAccountId: 'agent-account-1',
      agentWalletAddress: '0x2222222222222222222222222222222222222222',
      agentStatus: 'pending_registration',
      agentKeyHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
      agentRegistrationTxHash: null,
      agentExpiresAt: new Date(expiresAt),
    };

    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet: null });
    prisma.userWallet.upsert = jest.fn().mockResolvedValue(wallet);
    openfort.authorizeEmbeddedAddress.mockResolvedValue({
      openfortUserId: 'openfort-user-1',
      accountId: 'embedded-account-1',
      address: wallet.walletAddress,
    });
    openfort.createAgentWallet.mockResolvedValue({
      id: wallet.agentOpenfortAccountId,
      address: wallet.agentWalletAddress,
      keyHash: wallet.agentKeyHash,
    });

    await expect(
      service.authorizeEmbeddedWallet('openfort-user-1', {
        openfortAccessToken: 'openfort-token',
        embeddedWalletAddress: wallet.walletAddress,
        chainId,
        agentExpiresAt: expiresAt,
      }),
    ).resolves.toMatchObject({
      agentRegistration: { expiresAt },
      wallet: { agentExpiresAt: expiresAt },
    });

    expect(prisma.userWallet.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ agentExpiresAt: new Date(expiresAt) }),
        update: expect.objectContaining({ agentExpiresAt: new Date(expiresAt) }),
      }),
    );
  });

  it('sets registration required while agent details exist but no tx hash is recorded', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet: null });
    const wallet = {
      id: 'wallet-1',
      userId: 'user-1',
      openfortAccountId: 'embedded-account-1',
      walletAddress: '0x1111111111111111111111111111111111111111',
      chainId: BigInt(chainId),
      status: 'active',
      agentOpenfortAccountId: 'agent-account-1',
      agentWalletAddress: '0x2222222222222222222222222222222222222222',
      agentStatus: 'registration_required',
      agentKeyHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
      agentRegistrationTxHash: null,
      agentExpiresAt: null,
    };
    prisma.userWallet.upsert = jest.fn().mockResolvedValue(wallet);
    openfort.authorizeEmbeddedAddress.mockResolvedValue({
      openfortUserId: 'openfort-user-1',
      accountId: 'embedded-account-1',
      address: wallet.walletAddress,
    });
    openfort.createAgentWallet.mockResolvedValue({
      id: wallet.agentOpenfortAccountId,
      address: wallet.agentWalletAddress,
      keyHash: wallet.agentKeyHash,
    });

    await service.authorizeEmbeddedWallet('openfort-user-1', {
      openfortAccessToken: 'openfort-token',
      embeddedWalletAddress: wallet.walletAddress,
      chainId,
    });

    expect(prisma.userWallet.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ agentStatus: 'registration_required', agentRegistrationTxHash: null }),
        update: expect.objectContaining({ agentStatus: 'registration_required', agentRegistrationTxHash: null }),
      }),
    );
  });

  it('rejects past Calibur agent expiry times', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet: null });
    openfort.authorizeEmbeddedAddress.mockResolvedValue({
      openfortUserId: 'openfort-user-1',
      accountId: 'embedded-account-1',
      address: '0x1111111111111111111111111111111111111111',
    });
    openfort.createAgentWallet.mockResolvedValue({
      id: 'agent-account-1',
      address: '0x2222222222222222222222222222222222222222',
      keyHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
    });

    await expect(
      service.authorizeEmbeddedWallet('openfort-user-1', {
        openfortAccessToken: 'openfort-token',
        embeddedWalletAddress: '0x1111111111111111111111111111111111111111',
        chainId,
        agentExpiresAt: '2020-01-01T00:00:00.000Z',
      }),
    ).rejects.toThrow('Agent expiry time must be in the future');

    expect(prisma.userWallet.upsert).not.toHaveBeenCalled();
  });

  it('records the pending agent registration transaction hash for an active wallet', async () => {
    const wallet = {
      id: 'wallet-1',
      userId: 'user-1',
      openfortAccountId: 'embedded-account-1',
      status: 'active',
      chainId: BigInt(chainId),
      walletAddress: '0x1111111111111111111111111111111111111111',
      agentOpenfortAccountId: 'agent-account-1',
      agentWalletAddress: '0x2222222222222222222222222222222222222222',
      agentStatus: 'pending_registration',
      agentKeyHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
      agentRegistrationTxHash: null,
      agentExpiresAt: null,
    };
    const txHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const updatedWallet = { ...wallet, agentRegistrationTxHash: txHash };

    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet });
    prisma.userWallet.update.mockResolvedValue(updatedWallet);

    await expect(
      service.markAgentRegistrationTransaction('openfort-user-1', txHash),
    ).resolves.toMatchObject({
      userId: 'user-1',
      wallet: {
        agentStatus: 'pending_registration',
        agentRegistrationTxHash: txHash,
      },
    });

    expect(prisma.userWallet.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: {
        agentStatus: 'pending_registration',
        agentRegistrationTxHash: txHash,
      },
    });
  });

  it('verifies on-chain agent registration before marking registered', async () => {
    const wallet = {
      id: 'wallet-1',
      userId: 'user-1',
      openfortAccountId: 'embedded-account-1',
      status: 'active',
      chainId: BigInt(chainId),
      walletAddress: '0x1111111111111111111111111111111111111111',
      agentOpenfortAccountId: 'agent-account-1',
      agentWalletAddress: '0x2222222222222222222222222222222222222222',
      agentStatus: 'pending_registration',
      agentKeyHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
      agentRegistrationTxHash: null,
      agentExpiresAt: null,
    };
    const txHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const updatedWallet = { ...wallet, agentStatus: 'registered', agentRegistrationTxHash: txHash };

    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet });
    openfort.verifyAgentKeyRegistration.mockResolvedValue({ registered: true });
    prisma.userWallet.update.mockResolvedValue(updatedWallet);

    await expect(
      service.markAgentRegistrationResult('openfort-user-1', 'registered', txHash),
    ).resolves.toEqual({
      userId: 'user-1',
      wallet: {
        walletAddress: updatedWallet.walletAddress,
        embeddedWalletAddress: updatedWallet.walletAddress,
        chainId,
        status: 'active',
        supportedTokens: ['USDC', 'ETH'],
        agentWalletAddress: updatedWallet.agentWalletAddress,
        agentStatus: 'registered',
        agentKeyHash: updatedWallet.agentKeyHash,
        agentRegistrationTxHash: updatedWallet.agentRegistrationTxHash,
        agentExpiresAt: null,
      },
    });

    expect(openfort.verifyAgentKeyRegistration).toHaveBeenCalledWith({
      accountAddress: wallet.walletAddress,
      chainId,
      keyHash: wallet.agentKeyHash,
    });
    expect(prisma.userWallet.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { agentStatus: 'registered', agentRegistrationTxHash: txHash },
    });
    expect(openfort.verifyAgentKeyRegistration.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.userWallet.update.mock.invocationCallOrder[0],
    );
  });

  it('does not mark registered when on-chain agent verification fails', async () => {
    const wallet = {
      id: 'wallet-1',
      userId: 'user-1',
      openfortAccountId: 'embedded-account-1',
      status: 'active',
      chainId: BigInt(chainId),
      walletAddress: '0x1111111111111111111111111111111111111111',
      agentOpenfortAccountId: 'agent-account-1',
      agentWalletAddress: '0x2222222222222222222222222222222222222222',
      agentStatus: 'pending_registration',
      agentKeyHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
      agentRegistrationTxHash: null,
      agentExpiresAt: null,
    };
    const txHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet });
    openfort.verifyAgentKeyRegistration.mockRejectedValue(new Error('verification failed'));

    await expect(
      service.markAgentRegistrationResult('openfort-user-1', 'registered', txHash),
    ).rejects.toThrow('verification failed');

    expect(prisma.userWallet.update).not.toHaveBeenCalled();
  });

  it('marks registration failed without chain verification', async () => {
    const wallet = {
      id: 'wallet-1',
      userId: 'user-1',
      openfortAccountId: 'embedded-account-1',
      status: 'active',
      chainId: BigInt(chainId),
      walletAddress: '0x1111111111111111111111111111111111111111',
      agentOpenfortAccountId: 'agent-account-1',
      agentWalletAddress: '0x2222222222222222222222222222222222222222',
      agentStatus: 'pending_registration',
      agentKeyHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
      agentRegistrationTxHash: null,
      agentExpiresAt: null,
    };
    const txHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const updatedWallet = { ...wallet, agentStatus: 'registration_failed', agentRegistrationTxHash: txHash };

    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet });
    prisma.userWallet.update.mockResolvedValue(updatedWallet);

    await expect(
      service.markAgentRegistrationResult('openfort-user-1', 'registration_failed', txHash),
    ).resolves.toMatchObject({
      userId: 'user-1',
      wallet: expect.objectContaining({ agentStatus: 'registration_failed' }),
    });

    expect(openfort.verifyAgentKeyRegistration).not.toHaveBeenCalled();
    expect(prisma.userWallet.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { agentStatus: 'registration_failed', agentRegistrationTxHash: txHash },
    });
  });

  it('normalizes pending agent rows without tx hash to registration required on getMe', async () => {
    const wallet = {
      id: 'wallet-1',
      userId: 'user-1',
      openfortAccountId: 'embedded-account-1',
      status: 'active',
      chainId: BigInt(chainId),
      walletAddress: '0x1111111111111111111111111111111111111111',
      agentOpenfortAccountId: 'agent-account-1',
      agentWalletAddress: '0x2222222222222222222222222222222222222222',
      agentStatus: 'pending_registration',
      agentKeyHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
      agentRegistrationTxHash: null,
      agentExpiresAt: null,
    };

    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet });
    prisma.userWallet.update.mockResolvedValue({ ...wallet, agentStatus: 'registration_required' });

    await expect(service.getMe('openfort-user-1')).resolves.toMatchObject({
      wallet: { agentStatus: 'registration_required' },
    });

    expect(openfort.getTransactionReceiptStatus).not.toHaveBeenCalled();
    expect(prisma.userWallet.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { agentStatus: 'registration_required' },
    });
  });

  it('self-heals pending agent registration to registered when receipt is successful', async () => {
    const wallet = {
      id: 'wallet-1',
      userId: 'user-1',
      openfortAccountId: 'embedded-account-1',
      status: 'active',
      chainId: BigInt(chainId),
      walletAddress: '0x1111111111111111111111111111111111111111',
      agentOpenfortAccountId: 'agent-account-1',
      agentWalletAddress: '0x2222222222222222222222222222222222222222',
      agentStatus: 'pending_registration',
      agentKeyHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
      agentRegistrationTxHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      agentExpiresAt: null,
    };

    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet });
    openfort.getTransactionReceiptStatus = jest.fn().mockResolvedValue('success');
    openfort.verifyAgentKeyRegistration.mockResolvedValue(undefined);
    prisma.userWallet.update.mockResolvedValue({ ...wallet, agentStatus: 'registered' });

    await expect(service.getMe('openfort-user-1')).resolves.toMatchObject({
      wallet: { agentStatus: 'registered' },
    });

    expect(openfort.getTransactionReceiptStatus).toHaveBeenCalledWith(chainId, wallet.agentRegistrationTxHash);
    expect(openfort.verifyAgentKeyRegistration).toHaveBeenCalled();
  });

  it('marks pending agent registration failed when receipt is reverted', async () => {
    const wallet = {
      id: 'wallet-1',
      userId: 'user-1',
      openfortAccountId: 'embedded-account-1',
      status: 'active',
      chainId: BigInt(chainId),
      walletAddress: '0x1111111111111111111111111111111111111111',
      agentOpenfortAccountId: 'agent-account-1',
      agentWalletAddress: '0x2222222222222222222222222222222222222222',
      agentStatus: 'pending_registration',
      agentKeyHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
      agentRegistrationTxHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      agentExpiresAt: null,
    };

    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet });
    openfort.getTransactionReceiptStatus = jest.fn().mockResolvedValue('reverted');
    prisma.userWallet.update.mockResolvedValue({ ...wallet, agentStatus: 'registration_failed' });

    await expect(service.getMe('openfort-user-1')).resolves.toMatchObject({
      wallet: { agentStatus: 'registration_failed' },
    });

    expect(openfort.verifyAgentKeyRegistration).not.toHaveBeenCalled();
  });

  it('keeps pending agent registration when receipt is missing, receipt check fails, or verification fails', async () => {
    const wallet = {
      id: 'wallet-1',
      userId: 'user-1',
      openfortAccountId: 'embedded-account-1',
      status: 'active',
      chainId: BigInt(chainId),
      walletAddress: '0x1111111111111111111111111111111111111111',
      agentOpenfortAccountId: 'agent-account-1',
      agentWalletAddress: '0x2222222222222222222222222222222222222222',
      agentStatus: 'pending_registration',
      agentKeyHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
      agentRegistrationTxHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      agentExpiresAt: null,
    };

    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet });
    openfort.getTransactionReceiptStatus = jest.fn().mockResolvedValue(null);

    await expect(service.getMe('openfort-user-1')).resolves.toMatchObject({
      wallet: { agentStatus: 'pending_registration' },
    });

    openfort.getTransactionReceiptStatus.mockRejectedValue(new Error('rpc unavailable'));

    await expect(service.getMe('openfort-user-1')).resolves.toMatchObject({
      wallet: { agentStatus: 'pending_registration' },
    });

    openfort.getTransactionReceiptStatus.mockResolvedValue('success');
    openfort.verifyAgentKeyRegistration.mockRejectedValue(new Error('rpc lag'));

    await expect(service.getMe('openfort-user-1')).resolves.toMatchObject({
      wallet: { agentStatus: 'pending_registration' },
    });
  });
});
