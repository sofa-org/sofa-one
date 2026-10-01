import { AuthService } from './auth.service';

jest.mock('../../core/openfort/openfort.service', () => ({ OpenfortService: class {} }));

describe('AuthService durable embedded-wallet provisioning', () => {
  const wallet = { id: 'w1', userId: 'u1', status: 'pending_embedded_wallet', isDefault: false,
    openfortAccountId: 'embedded-1', walletAddress: '0x0000000000000000000000000000000000000001',
    agentOpenfortAccountId: null, agentWalletAddress: null, agentKeyHash: null, frozenAt: null,
    chainAuthorizations: [], provisioningIntent: null };
  let service: AuthService;
  let prisma: any;
  let openfort: any;
  let lifecycle: any;
  let intent: any;

  beforeEach(() => {
    wallet.provisioningIntent = null;
    intent = { id: 'i1', walletId: 'w1', status: 'pending', dispatchToken: null };
    const tx: any = {
      user: { findUniqueOrThrow: jest.fn().mockResolvedValue({ frozenAt: null }) },
      userWallet: {
        findMany: jest.fn().mockResolvedValue([wallet]), findUniqueOrThrow: jest.fn().mockResolvedValue(wallet),
        findFirst: jest.fn(), create: jest.fn(), update: jest.fn().mockResolvedValue(wallet), updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      walletProvisioningIntent: { create: jest.fn(async () => { wallet.provisioningIntent = intent; return intent; }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'u1', frozenAt: null }) },
      userWallet: {
        findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn().mockResolvedValue(wallet), findFirstOrThrow: jest.fn().mockResolvedValue(wallet),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      walletChainAuthorization: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      walletProvisioningIntent: {
        findUniqueOrThrow: jest.fn(async () => intent),
        updateMany: jest.fn(async ({ data }: any) => { Object.assign(intent, data); return { count: 1 }; }),
      },
      $transaction: jest.fn((fn) => fn(tx)), __tx: tx,
    };
    openfort = {
      authorizeEmbeddedAddress: jest.fn().mockResolvedValue({ openfortUserId: 'of1', accountId: 'embedded-1', address: wallet.walletAddress }),
      createAgentWallet: jest.fn().mockResolvedValue({ id: 'agent-1', address: '0x0000000000000000000000000000000000000002', keyHash: `0x${'a'.repeat(64)}` }),
    };
    lifecycle = {
      withWalletAccountLock: jest.fn(async (_user: string, work: Function) => work(tx, 'ba1', new Date())),
      assertWalletReservationAllowed: jest.fn(), recordWalletActivation: jest.fn(), initializeWalletCount: jest.fn(),
    };
    service = new AuthService(prisma, openfort, {} as any, {} as any, {} as any, lifecycle, undefined, undefined);
    prisma.__intent = intent;
    prisma.__tx.walletProvisioningIntent.updateMany.mockImplementation(async ({ data }: any) => {
      Object.assign(intent, data); return { count: 1 };
    });
  });

  const authorize = () => service.authorizeEmbeddedWallet('of1', 'token', { embeddedWalletAddress: wallet.walletAddress } as any);

  it('moves provider failure to uncertain and never retries creation', async () => {
    openfort.createAgentWallet.mockRejectedValue(new Error('provider unavailable'));
    await expect(authorize()).rejects.toThrow('provider unavailable');
    expect(intent.status).toBe('uncertain');
    await expect(authorize()).rejects.toThrow('pending review');
    expect(openfort.createAgentWallet).toHaveBeenCalledTimes(1);
  });

  it('retains known provisioning when activation fails, then retries activation only', async () => {
    prisma.__tx.userWallet.update.mockRejectedValueOnce(new Error('quota changed'));
    await expect(authorize()).rejects.toThrow();
    expect(intent.status).toBe('provisioned');
    await expect(authorize()).resolves.toBeDefined();
    expect(openfort.createAgentWallet).toHaveBeenCalledTimes(1);
  });

  it('keeps provisioned result durable when latest user is frozen before activation', async () => {
    prisma.__tx.user.findUniqueOrThrow
      .mockResolvedValueOnce({ frozenAt: null })
      .mockResolvedValueOnce({ frozenAt: new Date() });
    await expect(authorize()).rejects.toThrow('frozen');
    expect(intent.status).toBe('provisioned');
    expect(prisma.__tx.userWallet.update).not.toHaveBeenCalled();
    expect(openfort.createAgentWallet).toHaveBeenCalledTimes(1);
  });

  it('does not map stale default values over the freshly repaired wallet rows', async () => {
    const second = { ...wallet, id: 'w2', isDefault: false };
    const fresh = [{ ...second, isDefault: true }, { ...wallet, isDefault: false }];
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', wallets: [wallet, second] });
    prisma.__tx.userWallet.findMany.mockReset()
      .mockResolvedValueOnce([wallet, second])
      .mockResolvedValueOnce(fresh);
    const result = await service.getMe('of1');
    expect(result.wallet.id).toBe('w2');
    expect(result.wallet.isDefault).toBe(true);
    expect(result.wallets[1]).toMatchObject({ id: 'w1', isDefault: false });
  });

  it('rejects claimed identities owned by another user', async () => {
    prisma.userWallet.findMany.mockResolvedValue([{ userId: 'other-user' }]);
    await expect(authorize()).rejects.toThrow('already bound');
    expect(openfort.createAgentWallet).not.toHaveBeenCalled();
  });

  it('rejects caller-supplied account identity that differs from provider verification', async () => {
    await expect(service.authorizeEmbeddedWallet('of1', 'token', { embeddedWalletAddress: wallet.walletAddress, embeddedOpenfortAccountId: 'spoof' } as any)).rejects.toThrow('does not match provider verification');
    expect(openfort.createAgentWallet).not.toHaveBeenCalled();
  });

  it('requires walletId when registration is ambiguous and rejects another owner wallet', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
    prisma.userWallet.findMany.mockResolvedValue([wallet, { ...wallet, id: 'w2' }]);
    await expect(service.markAgentRegistrationTransaction('of1', 84532, '0xaaa')).rejects.toThrow('walletId is required');
    prisma.userWallet.findFirst.mockResolvedValue(null);
    await expect(service.markAgentRegistrationTransaction('of1', 84532, '0xaaa', 'foreign-wallet')).rejects.toThrow('Wallet not found');
  });

  it('does not overwrite registration state when receipt tx hash is stale', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
    prisma.userWallet.findFirst.mockResolvedValue({ ...wallet, status: 'active', agentOpenfortAccountId: 'agent', agentWalletAddress: '0x0000000000000000000000000000000000000002', agentKeyHash: `0x${'a'.repeat(64)}`, chainAuthorizations: [{ chainId: 84532n, status: 'pending_registration', registrationTxHash: '0xnew' }] });
    await expect(service.markAgentRegistrationResult('of1', 84532, 'registration_failed', '0xold', 'w1')).rejects.toThrow('not pending');
    expect(prisma.walletChainAuthorization.updateMany).not.toHaveBeenCalled();
  });

  it.each(['account', 'address'])('fills only a missing verified legacy %s binding', async (missing) => {
    const legacy = { ...wallet, openfortAccountId: missing === 'account' ? null : wallet.openfortAccountId, walletAddress: missing === 'address' ? null : wallet.walletAddress };
    prisma.__tx.userWallet.findMany.mockResolvedValue([legacy]);
    prisma.__tx.userWallet.updateMany.mockResolvedValue({ count: 1 });
    await expect(authorize()).resolves.toBeDefined();
    expect(prisma.__tx.userWallet.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining(missing === 'account' ? { openfortAccountId: 'embedded-1' } : { walletAddress: wallet.walletAddress }) }));
    expect(openfort.createAgentWallet).toHaveBeenCalledTimes(1);
  });

  it('activates a complete legacy agent binding without creating another agent', async () => {
    const legacy = { ...wallet, agentOpenfortAccountId: 'old-agent', agentWalletAddress: '0x0000000000000000000000000000000000000002', agentKeyHash: `0x${'b'.repeat(64)}` };
    prisma.__tx.userWallet.findMany.mockResolvedValue([legacy]);
    prisma.__tx.userWallet.findUniqueOrThrow.mockResolvedValue(legacy);
    await expect(authorize()).resolves.toBeDefined();
    expect(openfort.createAgentWallet).not.toHaveBeenCalled();
    expect(lifecycle.recordWalletActivation).toHaveBeenCalled();
  });

  it('fails closed on partial legacy agent identity and active all-null agent state', async () => {
    prisma.__tx.userWallet.findMany.mockResolvedValue([{ ...wallet, agentOpenfortAccountId: 'partial-agent' }]);
    await expect(authorize()).rejects.toThrow('Incomplete agent wallet identity');
    expect(openfort.createAgentWallet).not.toHaveBeenCalled();
    prisma.__tx.userWallet.findMany.mockResolvedValue([{ ...wallet, status: 'active' }]);
    await expect(authorize()).rejects.toThrow('Active wallet agent identity requires review');
    expect(openfort.createAgentWallet).not.toHaveBeenCalled();
  });

  it('retries failed registration by CAS and rejects concurrent stale submission', async () => {
    const owned = { ...wallet, status: 'active', agentOpenfortAccountId: 'agent', agentWalletAddress: '0x0000000000000000000000000000000000000002', agentKeyHash: `0x${'a'.repeat(64)}`, chainAuthorizations: [{ chainId: 84532n, status: 'registration_failed', registrationTxHash: '0xold' }] };
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', frozenAt: null });
    prisma.userWallet.findFirst.mockResolvedValue(owned);
    await service.markAgentRegistrationTransaction('of1', 84532, '0xnew', 'w1');
    expect(prisma.walletChainAuthorization.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'registration_failed', registrationTxHash: '0xold' }) }));
    prisma.walletChainAuthorization.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.markAgentRegistrationTransaction('of1', 84532, '0xother', 'w1')).rejects.toThrow('changed');
  });

  it.each(['registered', 'expired'])('explicitly renews a %s registration with CAS', async (status) => {
    const active = { ...wallet, status: 'active', agentOpenfortAccountId: 'agent', agentWalletAddress: '0x0000000000000000000000000000000000000002', agentKeyHash: `0x${'a'.repeat(64)}` };
    prisma.__tx.userWallet.findMany.mockResolvedValue([active]);
    prisma.userWallet.findFirstOrThrow.mockResolvedValue({ ...active, chainAuthorizations: [{ chainId: 84532n, status, registrationTxHash: '0xold' }] });
    await service.authorizeEmbeddedWallet('of1', 'token', { embeddedWalletAddress: wallet.walletAddress, chainId: 84532, agentExpiresAt: '2026-09-30T00:00:00.000Z' } as any);
    expect(prisma.walletChainAuthorization.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status, registrationTxHash: '0xold' }), data: expect.objectContaining({ status: 'registration_required', registrationTxHash: null }) }));
    expect(prisma.walletChainAuthorization.create).toBeUndefined();
  });

  it('does not reset a registered authorization during ordinary sign-in', async () => {
    const active = { ...wallet, status: 'active', agentOpenfortAccountId: 'agent', agentWalletAddress: '0x0000000000000000000000000000000000000002', agentKeyHash: `0x${'a'.repeat(64)}` };
    prisma.__tx.userWallet.findMany.mockResolvedValue([active]);
    prisma.userWallet.findFirstOrThrow.mockResolvedValue({ ...active, chainAuthorizations: [{ chainId: 84532n, status: 'registered', registrationTxHash: '0xold' }] });
    await service.authorizeEmbeddedWallet('of1', 'token', { embeddedWalletAddress: wallet.walletAddress, chainId: 84532 } as any);
    expect(prisma.walletChainAuthorization.updateMany).not.toHaveBeenCalled();
  });

  it('renews an expired failed registration with CAS and clears its old transaction hash', async () => {
    const active = { ...wallet, status: 'active', agentOpenfortAccountId: 'agent', agentWalletAddress: '0x0000000000000000000000000000000000000002', agentKeyHash: `0x${'a'.repeat(64)}` };
    prisma.__tx.userWallet.findMany.mockResolvedValue([active]);
    prisma.userWallet.findFirstOrThrow.mockResolvedValue({ ...active, chainAuthorizations: [{ chainId: 84532n, status: 'registration_failed', registrationTxHash: '0xold', expiresAt: new Date('2026-01-01T00:00:00.000Z') }] });
    await service.authorizeEmbeddedWallet('of1', 'token', { embeddedWalletAddress: wallet.walletAddress, chainId: 84532, agentExpiresAt: '2026-09-30T00:00:00.000Z' } as any);
    expect(prisma.walletChainAuthorization.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'registration_failed', registrationTxHash: '0xold', wallet: { is: { frozenAt: null, user: { is: { frozenAt: null } } } } }), data: expect.objectContaining({ status: 'registration_required', registrationTxHash: null, expiresAt: new Date('2026-09-30T00:00:00.000Z') }) }));
  });

  it('preserves a concurrent pending registration hash during explicit authorization', async () => {
    const active = { ...wallet, status: 'active', agentOpenfortAccountId: 'agent', agentWalletAddress: '0x0000000000000000000000000000000000000002', agentKeyHash: `0x${'a'.repeat(64)}` };
    prisma.__tx.userWallet.findMany.mockResolvedValue([active]);
    prisma.userWallet.findFirstOrThrow.mockResolvedValue({ ...active, chainAuthorizations: [{ chainId: 84532n, status: 'pending_registration', registrationTxHash: '0xinflight' }] });
    await service.authorizeEmbeddedWallet('of1', 'token', { embeddedWalletAddress: wallet.walletAddress, chainId: 84532, agentExpiresAt: '2026-09-30T00:00:00.000Z' } as any);
    expect(prisma.walletChainAuthorization.updateMany).not.toHaveBeenCalled();
  });

  it('initializes legacy wallet count while reauthorizing an already-active wallet', async () => {
    const active = { ...wallet, status: 'active', agentOpenfortAccountId: 'agent', agentWalletAddress: '0x0000000000000000000000000000000000000002', agentKeyHash: `0x${'a'.repeat(64)}` };
    prisma.__tx.userWallet.findMany.mockResolvedValue([active]);
    await authorize();
    expect(lifecycle.initializeWalletCount).toHaveBeenCalledWith(prisma.__tx, 'ba1', 'u1', expect.any(Date));
    expect(lifecycle.recordWalletActivation).not.toHaveBeenCalled();
  });

  it('records the active eligibility transition when verified authorization fills a legacy address', async () => {
    const legacy = { ...wallet, status: 'active', walletAddress: null, agentOpenfortAccountId: 'agent', agentWalletAddress: '0x0000000000000000000000000000000000000002', agentKeyHash: `0x${'a'.repeat(64)}` };
    const repaired = { ...legacy, walletAddress: wallet.walletAddress };
    prisma.__tx.userWallet.findMany.mockResolvedValueOnce([legacy]).mockResolvedValue([repaired]);
    await service.authorizeEmbeddedWallet('of1', 'token', { embeddedWalletAddress: wallet.walletAddress } as any);
    expect(lifecycle.recordWalletActivation).toHaveBeenCalledTimes(1);
    expect(openfort.createAgentWallet).not.toHaveBeenCalled();
  });

  it('fails the address repair closed at quota without creating an agent', async () => {
    const legacy = { ...wallet, status: 'active', walletAddress: null, agentOpenfortAccountId: 'agent', agentWalletAddress: '0x0000000000000000000000000000000000000002', agentKeyHash: `0x${'a'.repeat(64)}` };
    prisma.__tx.userWallet.findMany.mockResolvedValue([legacy]);
    lifecycle.recordWalletActivation.mockRejectedValue(new Error('quota cap'));
    await expect(service.authorizeEmbeddedWallet('of1', 'token', { embeddedWalletAddress: wallet.walletAddress } as any)).rejects.toThrow('quota cap');
    expect(lifecycle.recordWalletActivation).toHaveBeenCalledTimes(1);
    expect(openfort.createAgentWallet).not.toHaveBeenCalled();
  });

  it.each(['user', 'wallet'])('fails closed when a %s is frozen before renewal CAS', async (which) => {
    const active = { ...wallet, status: 'active', frozenAt: null, agentOpenfortAccountId: 'agent', agentWalletAddress: '0x0000000000000000000000000000000000000002', agentKeyHash: `0x${'a'.repeat(64)}` };
    prisma.__tx.userWallet.findMany.mockResolvedValue([active]);
    prisma.userWallet.findFirstOrThrow.mockResolvedValue({ ...active, chainAuthorizations: [{ chainId: 84532n, status: 'registered', registrationTxHash: '0xold' }] });
    if (which === 'user') prisma.user.findUnique.mockResolvedValue({ id: 'u1', frozenAt: new Date() });
    else {
      prisma.walletChainAuthorization.updateMany.mockResolvedValueOnce({ count: 0 });
    }
    await expect(service.authorizeEmbeddedWallet('of1', 'token', { embeddedWalletAddress: wallet.walletAddress, chainId: 84532, agentExpiresAt: '2026-09-30T00:00:00.000Z' } as any)).rejects.toThrow();
    if (which === 'wallet') expect(prisma.walletChainAuthorization.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ wallet: { is: { frozenAt: null, user: { is: { frozenAt: null } } } } }) }));
    expect(openfort.createAgentWallet).not.toHaveBeenCalled();
  });

  it('does not clobber a registration renewed concurrently with a submission', async () => {
    const active = { ...wallet, status: 'active', agentOpenfortAccountId: 'agent', agentWalletAddress: '0x0000000000000000000000000000000000000002', agentKeyHash: `0x${'a'.repeat(64)}` };
    prisma.__tx.userWallet.findMany.mockResolvedValue([active]);
    prisma.userWallet.findFirstOrThrow.mockResolvedValue({ ...active, chainAuthorizations: [{ chainId: 84532n, status: 'registered', registrationTxHash: '0xold' }] });
    prisma.walletChainAuthorization.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.authorizeEmbeddedWallet('of1', 'token', { embeddedWalletAddress: wallet.walletAddress, chainId: 84532, agentExpiresAt: '2026-09-30T00:00:00.000Z' } as any)).rejects.toThrow('raced');
    expect(prisma.walletChainAuthorization.updateMany).toHaveBeenCalledTimes(1);
  });

  it.each(['user', 'wallet'])('rejects registration writes for frozen %s', async (which) => {
    const owned = { ...wallet, status: 'active', frozenAt: which === 'wallet' ? new Date() : null, agentOpenfortAccountId: 'agent', agentWalletAddress: '0x0000000000000000000000000000000000000002', agentKeyHash: `0x${'a'.repeat(64)}`, chainAuthorizations: [{ chainId: 84532n, status: 'registration_required', registrationTxHash: null }] };
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', frozenAt: which === 'user' ? new Date() : null });
    prisma.userWallet.findFirst.mockResolvedValue(owned);
    await expect(service.markAgentRegistrationTransaction('of1', 84532, '0xnew', 'w1')).rejects.toThrow('frozen');
    expect(prisma.walletChainAuthorization.updateMany).not.toHaveBeenCalled();
  });
});
