import { AuthService } from './auth.service';

jest.mock('../../core/openfort/openfort.service', () => ({ OpenfortService: class {} }));

describe('AuthService', () => {
  const chainId = 84532;
  const futureDate = new Date('2027-05-06T00:00:00.000Z');
  const updatedAt = new Date('2026-05-06T00:00:00.000Z');
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
  let service: AuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    const tx = {
      user: { create: jest.fn().mockResolvedValue({ id: 'user-1' }) },
      userWallet: { create: jest.fn().mockResolvedValue({ walletAddress: null, status: 'pending_embedded_wallet', chainAuthorizations: [] }), upsert: jest.fn() },
      walletChainAuthorization: { upsert: jest.fn(), update: jest.fn() },
    };
    prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      userWallet: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn(), upsert: jest.fn(), findUniqueOrThrow: jest.fn() },
      walletChainAuthorization: { update: jest.fn(), upsert: jest.fn() },
      $transaction: jest.fn((cb) => cb(tx)),
      __tx: tx,
    };
    openfort = { createBackendWallet: jest.fn(), createAgentWallet: jest.fn(), authorizeEmbeddedAddress: jest.fn(), verifyAgentKeyRegistration: jest.fn(), getTransactionReceiptStatus: jest.fn() };
    apiKeyService = { createApiKey: jest.fn().mockResolvedValue({ rawKey: 'sk_test' }) };
    service = new AuthService(prisma, openfort, apiKeyService, { get: jest.fn((_k: string, fb: unknown) => fb), getOrThrow: jest.fn(() => 'secret') } as any);
  });

  it('creates a pending embedded-wallet record', async () => {
    await service.syncOpenfortSession('openfort-user-1', 'user@example.com');
    expect(prisma.__tx.userWallet.create).toHaveBeenCalledWith({ data: { userId: 'user-1', status: 'pending_embedded_wallet' }, include: { chainAuthorizations: true } });
  });

  it('records agent registration transaction per chain', async () => {
    const wallet = { id: 'wallet-1', userId: 'user-1', status: 'active', walletAddress: '0x1111111111111111111111111111111111111111', agentOpenfortAccountId: 'agent-account-1', agentWalletAddress: '0x2222222222222222222222222222222222222222', agentKeyHash: '0x3333333333333333333333333333333333333333333333333333333333333333', chainAuthorizations: [auth({ status: 'registration_required' })] };
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet });
    prisma.walletChainAuthorization.update.mockResolvedValue({});
    prisma.userWallet.findUniqueOrThrow.mockResolvedValue({ ...wallet, chainAuthorizations: [auth({ status: 'pending_registration', registrationTxHash: '0xaaa' })] });
    await expect(service.markAgentRegistrationTransaction('openfort-user-1', chainId, '0xaaa')).resolves.toMatchObject({ wallet: { chainAuthorizations: [expect.objectContaining({ status: 'pending_registration', registrationTxHash: '0xaaa' })] } });
  });

  it('records agent registration result per chain', async () => {
    const wallet = { id: 'wallet-1', userId: 'user-1', status: 'active', walletAddress: '0x1111111111111111111111111111111111111111', agentOpenfortAccountId: 'agent-account-1', agentWalletAddress: '0x2222222222222222222222222222222222222222', agentKeyHash: '0x3333333333333333333333333333333333333333333333333333333333333333', chainAuthorizations: [auth({ status: 'pending_registration', registrationTxHash: '0xaaa' })] };
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet });
    prisma.walletChainAuthorization.update.mockResolvedValue({});
    prisma.userWallet.findUniqueOrThrow.mockResolvedValue({ ...wallet, chainAuthorizations: [auth({ status: 'registered', registrationTxHash: '0xaaa' })] });
    await expect(service.markAgentRegistrationResult('openfort-user-1', chainId, 'registered', '0xaaa')).resolves.toMatchObject({ wallet: { chainAuthorizations: [expect.objectContaining({ status: 'registered', registrationTxHash: '0xaaa' })] } });
    expect(openfort.verifyAgentKeyRegistration).toHaveBeenCalledWith({ accountAddress: wallet.walletAddress, chainId, keyHash: wallet.agentKeyHash });
  });

  it('self-heals pending chain authorization on getMe', async () => {
    const wallet = { id: 'wallet-1', userId: 'user-1', status: 'active', walletAddress: '0x1111111111111111111111111111111111111111', agentOpenfortAccountId: 'agent-account-1', agentWalletAddress: '0x2222222222222222222222222222222222222222', agentKeyHash: '0x3333333333333333333333333333333333333333333333333333333333333333', chainAuthorizations: [auth({ status: 'pending_registration', registrationTxHash: '0xaaa' })] };
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wallet });
    prisma.walletChainAuthorization.update.mockResolvedValue({});
    prisma.userWallet.findUniqueOrThrow.mockResolvedValue({ ...wallet, chainAuthorizations: [auth({ status: 'registered', registrationTxHash: '0xaaa' })] });
    openfort.getTransactionReceiptStatus.mockResolvedValue('success');
    await expect(service.getMe('openfort-user-1')).resolves.toMatchObject({ wallet: { chainAuthorizations: [expect.objectContaining({ status: 'registered' })] } });
  });
});
