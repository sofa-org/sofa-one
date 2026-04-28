import { BadGatewayException } from '@nestjs/common';
import { AuthService } from './auth.service';

const getUser = jest.fn();

jest.mock('@clerk/backend', () => ({
  createClerkClient: jest.fn(() => ({
    users: { getUser },
  })),
}));

jest.mock('../../core/openfort/openfort.service', () => ({
  OpenfortService: class {},
}));

describe('AuthService', () => {
  const chainId = 84532;
  const clerkUser = {
    emailAddresses: [{ emailAddress: 'user@example.com' }],
    externalAccounts: [{ provider: 'oauth_google' }],
  };
  const provisioningWallet = {
    id: 'wallet-1',
    userId: 'user-1',
    openfortAccountId: null,
    walletAddress: null,
    chainId: BigInt(chainId),
    status: 'provisioning',
  };
  const activeWallet = {
    ...provisioningWallet,
    openfortAccountId: 'acc-1',
    walletAddress: '0xABCDEF1234567890ABCDEf1234567890abcdef12',
    status: 'active',
  };

  let prisma: any;
  let openfort: any;
  let apiKeyService: any;
  let service: AuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    getUser.mockResolvedValue(clerkUser);

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
        update: jest.fn().mockResolvedValue(activeWallet),
      },
      $transaction: jest.fn((callback) => callback(tx)),
      __tx: tx,
    };

    openfort = {
      createBackendWallet: jest
        .fn()
        .mockResolvedValue({ id: 'acc-1', address: activeWallet.walletAddress }),
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

  it('creates a local provisioning wallet before creating an Openfort wallet', async () => {
    const result = await service.handleSocialLogin('clerk-user-1');

    expect(prisma.__tx.userWallet.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        chainId: BigInt(chainId),
        status: 'provisioning',
      },
    });
    expect(openfort.createBackendWallet).toHaveBeenCalledTimes(1);
    expect(prisma.userWallet.update).toHaveBeenCalledWith({
      where: { id: 'wallet-1' },
      data: {
        openfortAccountId: 'acc-1',
        walletAddress: activeWallet.walletAddress,
        status: 'active',
      },
    });
    expect(prisma.__tx.userWallet.create.mock.invocationCallOrder[0]).toBeLessThan(
      openfort.createBackendWallet.mock.invocationCallOrder[0],
    );
    expect(result).toEqual({
      userId: 'user-1',
      wallet: {
        walletAddress: activeWallet.walletAddress,
        chainId,
        status: 'active',
        supportedTokens: ['USDC', 'ETH'],
      },
      apiKey: 'sk_test',
    });
  });

  it('marks the local wallet provisioning_failed when Openfort creation fails', async () => {
    const error = new BadGatewayException('Wallet service temporarily unavailable');
    openfort.createBackendWallet.mockRejectedValue(error);

    await expect(service.handleSocialLogin('clerk-user-1')).rejects.toThrow(error);

    expect(prisma.__tx.userWallet.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        chainId: BigInt(chainId),
        status: 'provisioning',
      },
    });
    expect(prisma.userWallet.update).toHaveBeenCalledWith({
      where: { id: 'wallet-1' },
      data: { status: 'provisioning_failed' },
    });
    expect(apiKeyService.createApiKey).not.toHaveBeenCalled();
  });
});
