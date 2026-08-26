import { AuthService } from './auth.service';
import { BillingQuotaExceededException } from '../billing/billing-quota.exception';

jest.mock('../../core/openfort/openfort.service', () => ({ OpenfortService: class {} }));

describe('AuthService', () => {
  const chainId = 84532;
  const updatedAt = new Date('2026-05-06T00:00:00.000Z');
  const futureDate = new Date('2026-05-13T00:00:00.000Z');
  const auth = (overrides: Record<string, unknown> = {}) => ({
    chainId: BigInt(chainId),
    status: 'registered',
    expiresAt: futureDate,
    registrationTxHash: null,
    updatedAt,
    ...overrides,
  });

  let prisma: any;
  let openfort: any;
  let apiKeyService: any;
  let securityEvents: any;
  let billingEntitlements: any;
  let service: AuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(updatedAt);
    const tx = {
      user: { create: jest.fn().mockResolvedValue({ id: 'user-1' }) },
      userWallet: {
        create: jest.fn().mockResolvedValue({
          walletAddress: null,
          status: 'pending_embedded_wallet',
          chainAuthorizations: [],
        }),
        upsert: jest.fn(),
        findUniqueOrThrow: jest.fn(),
      },
      walletChainAuthorization: { upsert: jest.fn(), update: jest.fn() },
    };
    prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      userWallet: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
        findUniqueOrThrow: jest.fn(),
      },
      walletChainAuthorization: { update: jest.fn(), upsert: jest.fn() },
      userKnownIp: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn((cb) => cb(tx)),
      __tx: tx,
    };
    openfort = {
      createBackendWallet: jest.fn(),
      createAgentWallet: jest.fn(),
      authorizeEmbeddedAddress: jest.fn(),
      verifyAgentKeyRegistration: jest.fn(),
      getTransactionReceiptStatus: jest.fn(),
    };
    apiKeyService = { createApiKey: jest.fn().mockResolvedValue({ rawKey: 'sk_test' }) };
    securityEvents = { record: jest.fn().mockResolvedValue({}) };
    billingEntitlements = { assertWalletActivationAllowed: jest.fn().mockResolvedValue(undefined) };
    service = new AuthService(
      prisma,
      openfort,
      apiKeyService,
      { get: jest.fn((_k: string, fb: unknown) => fb), getOrThrow: jest.fn(() => 'secret') } as any,
      billingEntitlements,
      undefined,
      securityEvents,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('authorizes embedded wallet without requiring an access token on the DTO', async () => {
    const wallet = {
      id: 'wallet-1',
      userId: 'user-1',
      status: 'active',
      walletAddress: '0x1111111111111111111111111111111111111111',
      agentOpenfortAccountId: 'agent-account-1',
      agentWalletAddress: '0x2222222222222222222222222222222222222222',
      agentKeyHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
      chainAuthorizations: [auth({ status: 'registration_required' })],
    };
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet });
    prisma.__tx.userWallet.upsert.mockResolvedValue(wallet);
    prisma.__tx.userWallet.findUniqueOrThrow.mockResolvedValue(wallet);
    openfort.authorizeEmbeddedAddress.mockResolvedValue({
      openfortUserId: 'openfort-user-1',
      address: '0x1111111111111111111111111111111111111111',
      accountId: 'acc-1',
    });

    const result = await service.authorizeEmbeddedWallet(
      'openfort-user-1',
      'openfort-access-token',
      {
        embeddedWalletAddress: wallet.walletAddress,
        embeddedOpenfortAccountId: 'embedded-acc-1',
        chainId: chainId,
        agentExpiresAt: futureDate.toISOString(),
      } as any,
    );

    expect(openfort.authorizeEmbeddedAddress).toHaveBeenCalledWith(
      'openfort-access-token',
      wallet.walletAddress,
    );
    expect(result).toMatchObject({
      userId: 'user-1',
      wallet: expect.objectContaining({
        walletAddress: wallet.walletAddress,
        status: 'active',
      }),
    });
    expect(result).not.toHaveProperty('agentRegistration');
    expect(result.wallet).not.toHaveProperty('embeddedWalletAddress');
    expect(result.wallet).not.toHaveProperty('supportedTokens');
    expect(result.wallet.chainAuthorizations[0]).not.toHaveProperty('updatedAt');
  });

  it('rejects agent authorization expiry beyond 30 days', async () => {
    const wallet = {
      id: 'wallet-1',
      userId: 'user-1',
      status: 'active',
      walletAddress: '0x1111111111111111111111111111111111111111',
      agentOpenfortAccountId: 'agent-account-1',
      agentWalletAddress: '0x2222222222222222222222222222222222222222',
      agentKeyHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
      chainAuthorizations: [],
    };
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet });
    openfort.authorizeEmbeddedAddress.mockResolvedValue({
      openfortUserId: 'openfort-user-1',
      address: wallet.walletAddress,
      accountId: 'acc-1',
    });

    await expect(
      service.authorizeEmbeddedWallet('openfort-user-1', 'openfort-access-token', {
        embeddedWalletAddress: wallet.walletAddress,
        chainId,
        agentExpiresAt: new Date(updatedAt.getTime() + 31 * 24 * 60 * 60 * 1000).toISOString(),
      } as any),
    ).rejects.toThrow('Agent expiry time must be within 30 days');

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('uses a short default agent registration expiry when no expiry is supplied', async () => {
    const wallet = {
      id: 'wallet-1',
      userId: 'user-1',
      status: 'active',
      walletAddress: '0x1111111111111111111111111111111111111111',
      agentOpenfortAccountId: 'agent-account-1',
      agentWalletAddress: '0x2222222222222222222222222222222222222222',
      agentKeyHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
      chainAuthorizations: [],
    };
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet });
    prisma.__tx.userWallet.upsert.mockResolvedValue(wallet);
    prisma.__tx.userWallet.findUniqueOrThrow.mockResolvedValue({
      ...wallet,
      chainAuthorizations: [
        auth({ status: 'registration_required', expiresAt: new Date('2026-05-06T00:05:00.000Z') }),
      ],
    });
    openfort.authorizeEmbeddedAddress.mockResolvedValue({
      openfortUserId: 'openfort-user-1',
      address: wallet.walletAddress,
      accountId: 'acc-1',
    });

    await expect(
      service.authorizeEmbeddedWallet('openfort-user-1', 'openfort-access-token', {
        embeddedWalletAddress: wallet.walletAddress,
        chainId,
      } as any),
    ).resolves.toMatchObject({
      wallet: {
        chainAuthorizations: [expect.objectContaining({ expiresAt: '2026-05-06T00:05:00.000Z' })],
      },
    });

    expect(prisma.__tx.walletChainAuthorization.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ expiresAt: new Date('2026-05-06T00:05:00.000Z') }),
        update: expect.objectContaining({ expiresAt: new Date('2026-05-06T00:05:00.000Z') }),
      }),
    );
  });

  it('creates a pending embedded-wallet record', async () => {
    await service.syncOpenfortSession('openfort-user-1', 'user@example.com');
    expect(prisma.__tx.userWallet.create).toHaveBeenCalledWith({
      data: { userId: 'user-1', status: 'pending_embedded_wallet' },
      include: { chainAuthorizations: true },
    });
  });

  it('records agent registration transaction per chain', async () => {
    const wallet = {
      id: 'wallet-1',
      userId: 'user-1',
      status: 'active',
      walletAddress: '0x1111111111111111111111111111111111111111',
      agentOpenfortAccountId: 'agent-account-1',
      agentWalletAddress: '0x2222222222222222222222222222222222222222',
      agentKeyHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
      chainAuthorizations: [auth({ status: 'registration_required' })],
    };
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet });
    prisma.walletChainAuthorization.update.mockResolvedValue({});
    prisma.userWallet.findUniqueOrThrow.mockResolvedValue({
      ...wallet,
      chainAuthorizations: [auth({ status: 'pending_registration', registrationTxHash: '0xaaa' })],
    });
    await expect(
      service.markAgentRegistrationTransaction('openfort-user-1', chainId, '0xaaa'),
    ).resolves.toMatchObject({
      wallet: {
        chainAuthorizations: [
          expect.objectContaining({ status: 'pending_registration', registrationTxHash: '0xaaa' }),
        ],
      },
    });
  });

  it('records agent registration result per chain', async () => {
    const wallet = {
      id: 'wallet-1',
      userId: 'user-1',
      status: 'active',
      walletAddress: '0x1111111111111111111111111111111111111111',
      agentOpenfortAccountId: 'agent-account-1',
      agentWalletAddress: '0x2222222222222222222222222222222222222222',
      agentKeyHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
      chainAuthorizations: [auth({ status: 'pending_registration', registrationTxHash: '0xaaa' })],
    };
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet });
    prisma.walletChainAuthorization.update.mockResolvedValue({});
    prisma.userWallet.findUniqueOrThrow.mockResolvedValue({
      ...wallet,
      chainAuthorizations: [auth({ status: 'registered', registrationTxHash: '0xaaa' })],
    });
    await expect(
      service.markAgentRegistrationResult('openfort-user-1', chainId, 'registered', '0xaaa'),
    ).resolves.toMatchObject({
      wallet: {
        chainAuthorizations: [
          expect.objectContaining({ status: 'registered', registrationTxHash: '0xaaa' }),
        ],
      },
    });
    expect(openfort.verifyAgentKeyRegistration).toHaveBeenCalledWith({
      accountAddress: wallet.walletAddress,
      chainId,
      keyHash: wallet.agentKeyHash,
    });
  });

  it('self-heals pending chain authorization on getMe', async () => {
    const wallet = {
      id: 'wallet-1',
      userId: 'user-1',
      status: 'active',
      walletAddress: '0x1111111111111111111111111111111111111111',
      agentOpenfortAccountId: 'agent-account-1',
      agentWalletAddress: '0x2222222222222222222222222222222222222222',
      agentKeyHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
      chainAuthorizations: [auth({ status: 'pending_registration', registrationTxHash: '0xaaa' })],
    };
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet });
    prisma.walletChainAuthorization.update.mockResolvedValue({});
    prisma.userWallet.findUniqueOrThrow.mockResolvedValue({
      ...wallet,
      chainAuthorizations: [auth({ status: 'registered', registrationTxHash: '0xaaa' })],
    });
    openfort.getTransactionReceiptStatus.mockResolvedValue('success');
    await expect(service.getMe('openfort-user-1')).resolves.toMatchObject({
      wallet: { chainAuthorizations: [expect.objectContaining({ status: 'registered' })] },
    });
  });

  describe('login IP tracking', () => {
    it('records a login.new_ip security event when the IP is new for the user', async () => {
      prisma.userKnownIp.findUnique.mockResolvedValue(null);
      prisma.userKnownIp.create.mockResolvedValue({
        id: 'kip-1',
        userId: 'user-1',
        ip: '203.0.113.5',
      });

      await service.syncOpenfortSession(
        'openfort-user-1',
        'user@example.com',
        '203.0.113.5',
        'Mozilla/5.0',
      );

      expect(prisma.userKnownIp.findUnique).toHaveBeenCalledWith({
        where: { userId_ip: { userId: 'user-1', ip: '203.0.113.5' } },
      });
      expect(prisma.userKnownIp.create).toHaveBeenCalledWith({
        data: { userId: 'user-1', ip: '203.0.113.5' },
      });
      expect(securityEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'user',
          eventType: 'login.new_ip',
          userId: 'user-1',
          riskLevel: 'medium',
          ip: '203.0.113.5',
          userAgent: 'Mozilla/5.0',
          result: 'allowed',
          reason: 'new_ip_login',
        }),
      );
    });

    it('does not record a login.new_ip event when the IP is already known', async () => {
      prisma.userKnownIp.findUnique.mockResolvedValue({
        id: 'kip-1',
        userId: 'user-1',
        ip: '203.0.113.5',
      });

      await service.syncOpenfortSession(
        'openfort-user-1',
        'user@example.com',
        '203.0.113.5',
        'Mozilla/5.0',
      );

      expect(prisma.userKnownIp.create).not.toHaveBeenCalled();
      expect(securityEvents.record).not.toHaveBeenCalled();
    });

    it('skips IP tracking when no client IP is provided', async () => {
      await service.syncOpenfortSession(
        'openfort-user-1',
        'user@example.com',
        undefined,
        'Mozilla/5.0',
      );

      expect(prisma.userKnownIp.findUnique).not.toHaveBeenCalled();
      expect(securityEvents.record).not.toHaveBeenCalled();
    });

    it('gracefully handles IP tracking errors without failing the login', async () => {
      prisma.userKnownIp.findUnique.mockRejectedValue(new Error('DB error'));

      const result = await service.syncOpenfortSession(
        'openfort-user-1',
        'user@example.com',
        '203.0.113.5',
        'Mozilla/5.0',
      );

      // Login should still succeed even if IP tracking fails
      expect(result).toBeDefined();
      expect(result.userId).toBe('user-1');
    });
  });

  describe('active-wallet quota seam', () => {
    const wallet = {
      id: 'wallet-1',
      userId: 'user-1',
      status: 'active',
      walletAddress: '0x1111111111111111111111111111111111111111',
      agentOpenfortAccountId: 'agent-account-1',
      agentWalletAddress: '0x2222222222222222222222222222222222222222',
      agentKeyHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
      chainAuthorizations: [],
    };
    // No agent fields: ensureAgentWallet would create an external TEE wallet.
    const walletWithoutAgent = {
      id: 'wallet-1',
      userId: 'user-1',
      status: 'active',
      walletAddress: '0x1111111111111111111111111111111111111111',
      agentOpenfortAccountId: null,
      agentWalletAddress: null,
      agentKeyHash: null,
      chainAuthorizations: [],
    };
    const agentWallet = {
      id: 'agent-account-1',
      address: '0x2222222222222222222222222222222222222222',
      keyHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
    };

    it('runs the wallet-activation quota decision inside the authorization transaction', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet });
      prisma.__tx.userWallet.upsert.mockResolvedValue(wallet);
      prisma.__tx.userWallet.findUniqueOrThrow.mockResolvedValue(wallet);
      openfort.authorizeEmbeddedAddress.mockResolvedValue({
        openfortUserId: 'openfort-user-1',
        address: wallet.walletAddress,
        accountId: 'acc-1',
      });

      await service.authorizeEmbeddedWallet('openfort-user-1', 'openfort-access-token', {
        embeddedWalletAddress: wallet.walletAddress,
        chainId,
      } as any);

      expect(billingEntitlements.assertWalletActivationAllowed).toHaveBeenCalledWith(
        'user-1',
        prisma.__tx,
      );
    });

    it('rejects activation with a 429 quota exception when the wallet quota is exceeded', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet });
      openfort.authorizeEmbeddedAddress.mockResolvedValue({
        openfortUserId: 'openfort-user-1',
        address: wallet.walletAddress,
        accountId: 'acc-1',
      });
      billingEntitlements.assertWalletActivationAllowed.mockRejectedValue(
        new BillingQuotaExceededException('active_wallets', 10, '2026-05'),
      );

      await expect(
        service.authorizeEmbeddedWallet('openfort-user-1', 'openfort-access-token', {
          embeddedWalletAddress: wallet.walletAddress,
          chainId,
        } as any),
      ).rejects.toBeInstanceOf(BillingQuotaExceededException);

      expect(prisma.__tx.userWallet.upsert).not.toHaveBeenCalled();
    });

    it('rejects before creating an external agent wallet when the quota is exhausted', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet: walletWithoutAgent });
      openfort.authorizeEmbeddedAddress.mockResolvedValue({
        openfortUserId: 'openfort-user-1',
        address: walletWithoutAgent.walletAddress,
        accountId: 'acc-1',
      });
      billingEntitlements.assertWalletActivationAllowed.mockRejectedValue(
        new BillingQuotaExceededException('active_wallets', 10, '2026-05'),
      );

      await expect(
        service.authorizeEmbeddedWallet('openfort-user-1', 'openfort-access-token', {
          embeddedWalletAddress: walletWithoutAgent.walletAddress,
          chainId,
        } as any),
      ).rejects.toBeInstanceOf(BillingQuotaExceededException);

      expect(openfort.createAgentWallet).not.toHaveBeenCalled();
      expect(prisma.__tx.userWallet.upsert).not.toHaveBeenCalled();
    });

    it('idempotently allows an existing active wallet and proceeds to authorization', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet });
      prisma.__tx.userWallet.upsert.mockResolvedValue(wallet);
      prisma.__tx.userWallet.findUniqueOrThrow.mockResolvedValue(wallet);
      openfort.authorizeEmbeddedAddress.mockResolvedValue({
        openfortUserId: 'openfort-user-1',
        address: wallet.walletAddress,
        accountId: 'acc-1',
      });

      const result = await service.authorizeEmbeddedWallet(
        'openfort-user-1',
        'openfort-access-token',
        { embeddedWalletAddress: wallet.walletAddress, chainId } as any,
      );

      expect(result).toMatchObject({
        userId: 'user-1',
        wallet: expect.objectContaining({ status: 'active' }),
      });
      // Preflight + authoritative in-transaction check both ran.
      expect(billingEntitlements.assertWalletActivationAllowed).toHaveBeenCalledTimes(2);
      expect(openfort.createAgentWallet).not.toHaveBeenCalled();
    });

    it('proceeds with external agent-wallet creation when the quota is available', async () => {
      const activated = { ...walletWithoutAgent, ...agentWallet };
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet: walletWithoutAgent });
      prisma.__tx.userWallet.upsert.mockResolvedValue(activated);
      prisma.__tx.userWallet.findUniqueOrThrow.mockResolvedValue(activated);
      openfort.authorizeEmbeddedAddress.mockResolvedValue({
        openfortUserId: 'openfort-user-1',
        address: walletWithoutAgent.walletAddress,
        accountId: 'acc-1',
      });
      openfort.createAgentWallet.mockResolvedValue(agentWallet);

      const result = await service.authorizeEmbeddedWallet(
        'openfort-user-1',
        'openfort-access-token',
        { embeddedWalletAddress: walletWithoutAgent.walletAddress, chainId } as any,
      );

      expect(openfort.createAgentWallet).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        userId: 'user-1',
        wallet: expect.objectContaining({ status: 'active' }),
      });
    });

    it('rejects an expired agent expiry before creating an external agent wallet', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet: walletWithoutAgent });
      openfort.authorizeEmbeddedAddress.mockResolvedValue({
        openfortUserId: 'openfort-user-1',
        address: walletWithoutAgent.walletAddress,
        accountId: 'acc-1',
      });

      await expect(
        service.authorizeEmbeddedWallet('openfort-user-1', 'openfort-access-token', {
          embeddedWalletAddress: walletWithoutAgent.walletAddress,
          chainId,
          agentExpiresAt: new Date(updatedAt.getTime() - 60 * 1000).toISOString(),
        } as any),
      ).rejects.toThrow('Agent expiry time must be in the future');

      expect(openfort.createAgentWallet).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects an over-30-day agent expiry before creating an external agent wallet', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet: walletWithoutAgent });
      openfort.authorizeEmbeddedAddress.mockResolvedValue({
        openfortUserId: 'openfort-user-1',
        address: walletWithoutAgent.walletAddress,
        accountId: 'acc-1',
      });

      await expect(
        service.authorizeEmbeddedWallet('openfort-user-1', 'openfort-access-token', {
          embeddedWalletAddress: walletWithoutAgent.walletAddress,
          chainId,
          agentExpiresAt: new Date(updatedAt.getTime() + 31 * 24 * 60 * 60 * 1000).toISOString(),
        } as any),
      ).rejects.toThrow('Agent expiry time must be within 30 days');

      expect(openfort.createAgentWallet).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('propagates preflight infrastructure failures without calling external wallet creation', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet: walletWithoutAgent });
      openfort.authorizeEmbeddedAddress.mockResolvedValue({
        openfortUserId: 'openfort-user-1',
        address: walletWithoutAgent.walletAddress,
        accountId: 'acc-1',
      });
      billingEntitlements.assertWalletActivationAllowed.mockRejectedValue(
        new Error('DB connection lost'),
      );

      await expect(
        service.authorizeEmbeddedWallet('openfort-user-1', 'openfort-access-token', {
          embeddedWalletAddress: walletWithoutAgent.walletAddress,
          chainId,
        } as any),
      ).rejects.toThrow('DB connection lost');

      expect(openfort.createAgentWallet).not.toHaveBeenCalled();
      expect(prisma.__tx.userWallet.upsert).not.toHaveBeenCalled();
    });

    it('keeps the authoritative in-transaction quota check for the preflight/activation race', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet });
      prisma.__tx.userWallet.upsert.mockResolvedValue(wallet);
      prisma.__tx.userWallet.findUniqueOrThrow.mockResolvedValue(wallet);
      openfort.authorizeEmbeddedAddress.mockResolvedValue({
        openfortUserId: 'openfort-user-1',
        address: wallet.walletAddress,
        accountId: 'acc-1',
      });

      await service.authorizeEmbeddedWallet('openfort-user-1', 'openfort-access-token', {
        embeddedWalletAddress: wallet.walletAddress,
        chainId,
      } as any);

      // Preflight runs against the PrismaService; the authoritative check runs
      // against the transaction client inside the same transaction as the upsert.
      expect(billingEntitlements.assertWalletActivationAllowed).toHaveBeenCalledWith(
        'user-1',
        prisma,
      );
      expect(billingEntitlements.assertWalletActivationAllowed).toHaveBeenCalledWith(
        'user-1',
        prisma.__tx,
      );
      expect(billingEntitlements.assertWalletActivationAllowed).toHaveBeenCalledTimes(2);
    });

    it('does not apply the wallet quota to the pending-wallet sync path', async () => {
      await service.syncOpenfortSession('openfort-user-1', 'user@example.com');

      expect(billingEntitlements.assertWalletActivationAllowed).not.toHaveBeenCalled();
    });
  });
});
