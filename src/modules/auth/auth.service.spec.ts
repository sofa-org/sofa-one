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
        agentExpiresAt: null,
      },
      apiKey: 'sk_test',
    });
  });

  it('issues the first API key while embedded wallet binding is pending', async () => {
    await expect(service.syncOpenfortSession('openfort-user-1', 'user@example.com')).resolves.toMatchObject({
      userId: 'user-1',
      apiKey: 'sk_test',
      wallet: { walletAddress: null },
    });

    expect(prisma.__tx.userWallet.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        chainId: BigInt(chainId),
        status: 'pending_embedded_wallet',
      },
    });
    expect(apiKeyService.createApiKey).toHaveBeenCalledWith('user-1', { name: 'Default' });
  });
});
