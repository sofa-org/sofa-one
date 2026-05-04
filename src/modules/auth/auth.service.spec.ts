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
      },
      $transaction: jest.fn((callback) => callback(tx)),
      __tx: tx,
    };

    openfort = {
      createBackendWallet: jest.fn(),
      createAgentWallet: jest.fn(),
      authorizeEmbeddedAddress: jest.fn(),
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

  it.each(['registered', 'registration_failed'] as const)(
    'marks agent registration as %s for an active wallet',
    async (agentStatus) => {
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
      const updatedWallet = { ...wallet, agentStatus, agentRegistrationTxHash: txHash };

      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet });
      prisma.userWallet.update.mockResolvedValue(updatedWallet);

      await expect(
        service.markAgentRegistrationResult(
          'openfort-user-1',
          agentStatus,
          txHash,
        ),
      ).resolves.toEqual({
        userId: 'user-1',
        wallet: {
          walletAddress: updatedWallet.walletAddress,
          embeddedWalletAddress: updatedWallet.walletAddress,
          chainId,
          status: 'active',
          supportedTokens: ['USDC', 'ETH'],
          agentWalletAddress: updatedWallet.agentWalletAddress,
          agentStatus,
          agentKeyHash: updatedWallet.agentKeyHash,
          agentRegistrationTxHash: updatedWallet.agentRegistrationTxHash,
          agentExpiresAt: null,
        },
      });

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { socialId: 'openfort-user-1' },
        include: { wallet: true },
      });
      expect(prisma.userWallet.update).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        data: { agentStatus, agentRegistrationTxHash: txHash },
      });
    },
  );
});
