import { UnauthorizedException } from '@nestjs/common';
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
    await expect(service.listApiKeyWallets('owner', 'bound-wallet')).resolves.toEqual({ wallets: [] });
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'owner', id: 'bound-wallet' },
      select: {
        id: true,
        walletAddress: true,
        agentWalletAddress: true,
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

  it('projects only the bound wallet without leaking internal metadata', async () => {
    findMany.mockResolvedValue([
      {
        id: 'wallet-a',
        walletAddress: '0x1',
        agentWalletAddress: '0x2',
        status: 'active',
        frozenAt: new Date(),
        openfortAccountId: 'must-not-leak',
        agentKeyHash: 'must-not-leak',
        chainAuthorizations: [
          { chainId: 10n, status: 'active', expiresAt: null, registrationTxHash: 'must-not-leak' },
        ],
      },
    ]);
    const result = await service.listApiKeyWallets('owner', 'wallet-a');
    expect(result).toEqual({
      wallets: [
        {
          id: 'wallet-a',
          walletAddress: '0x1',
          agentWalletAddress: '0x2',
          status: 'active',
          isFrozen: true,
          chainAuthorizations: [{ chainId: 10, status: 'active', expiresAt: null }],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'owner', id: 'wallet-a' } }));
  });

  it('returns null when the bound wallet has no signer address', async () => {
    findMany.mockResolvedValue([{ id: 'wallet-a', walletAddress: '0x1', status: 'active', frozenAt: null, chainAuthorizations: [] }]);
    await expect(service.listApiKeyWallets('owner', 'wallet-a')).resolves.toMatchObject({
      wallets: [{ walletAddress: '0x1', agentWalletAddress: null }],
    });
  });

  it('rejects unbound API keys without querying wallet metadata', async () => {
    await expect(service.listApiKeyWallets('owner', null)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(findMany).not.toHaveBeenCalled();
  });
});
