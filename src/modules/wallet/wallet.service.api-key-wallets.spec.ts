import { WalletService } from './wallet.service';

jest.mock('../../core/openfort/openfort.service', () => ({
  OpenfortService: class OpenfortService {},
}));

describe('WalletService.listApiKeyWallets', () => {
  const findMany = jest.fn();
  const service = new WalletService(
    { userWallet: { findMany } } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

  beforeEach(() => jest.clearAllMocks());

  it('returns an empty array and uses explicit owner-scoped safe selection', async () => {
    findMany.mockResolvedValue([]);
    await expect(service.listApiKeyWallets('owner')).resolves.toEqual({ wallets: [] });
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'owner' },
      select: {
        id: true,
        walletAddress: true,
        status: true,
        frozenAt: true,
        chainAuthorizations: {
          select: { chainId: true, status: true, expiresAt: true },
          orderBy: { chainId: 'asc' },
        },
      },
      orderBy: { id: 'asc' },
    });
  });

  it('projects multiple wallets, frozen metadata and authorizations without internal fields', async () => {
    findMany.mockResolvedValue([
      {
        id: 'wallet-a',
        walletAddress: '0x1',
        status: 'active',
        frozenAt: new Date(),
        openfortAccountId: 'must-not-leak',
        agentKeyHash: 'must-not-leak',
        chainAuthorizations: [
          { chainId: 10n, status: 'active', expiresAt: null, registrationTxHash: 'must-not-leak' },
        ],
      },
      {
        id: 'wallet-b',
        walletAddress: null,
        status: 'pending',
        frozenAt: null,
        chainAuthorizations: [],
      },
    ]);
    const result = await service.listApiKeyWallets('owner');
    expect(result).toEqual({
      wallets: [
        {
          id: 'wallet-a',
          walletAddress: '0x1',
          status: 'active',
          isFrozen: true,
          chainAuthorizations: [{ chainId: 10, status: 'active', expiresAt: null }],
        },
        {
          id: 'wallet-b',
          walletAddress: null,
          status: 'pending',
          isFrozen: false,
          chainAuthorizations: [],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
  });
});
