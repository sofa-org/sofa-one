import { ForbiddenException } from '@nestjs/common';
import { Request } from 'express';
jest.mock('./auth.service', () => ({ AuthService: class AuthService {} }));
jest.mock('../../common/guards/openfort-auth.guard', () => ({ OpenfortAuthGuard: class OpenfortAuthGuard {} }));
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AppSessionService } from '../app-session/app-session.service';

describe('wallet identity authorization', () => {
  const body = { embeddedWalletAddress: '0x1111111111111111111111111111111111111111' };
  function fixture(providerId = 'provider-1') {
    const auth = { authorizeEmbeddedWallet: jest.fn().mockResolvedValue({ wallet: 'stable-wallet-id' }), getMe: jest.fn(), markAgentRegistrationTransaction: jest.fn() };
    // Controller requests are already authenticated; only the immutable subject boundary is under test.
    const req = { openfortUserId: providerId, openfortAccessToken: 'fresh-provider-token', user: { id: 'local-user-id', socialId: 'provider-1' } } as unknown as Request;
    const controller = new AuthController(auth as unknown as AuthService, {} as AppSessionService);
    return { auth, req, controller };
  }

  it('rejects a fresh provider token from another user before any wallet mutation', async () => {
    const f = fixture('provider-2');
    await expect(f.controller.authorizeEmbeddedWallet(f.req, body)).rejects.toThrow(ForbiddenException);
    expect(f.auth.authorizeEmbeddedWallet).not.toHaveBeenCalled();
  });

  it('passes a matching provider proof without changing the local user/wallet identity', async () => {
    const f = fixture();
    expect(await f.controller.authorizeEmbeddedWallet(f.req, body)).toEqual({ wallet: 'stable-wallet-id' });
    expect(f.auth.authorizeEmbeddedWallet).toHaveBeenCalledWith('provider-1', 'fresh-provider-token', body);
    expect(f.req.user?.id).toBe('local-user-id');
  });

  it('reads wallet projection using the local session identity, not a provider request field', async () => {
    const f = fixture('untrusted-request-field');
    await f.controller.getMe(f.req);
    expect(f.auth.getMe).toHaveBeenCalledWith('provider-1');
  });

  it('uses local identity for registration without an IAM token', async () => {
    const f = fixture();
    delete f.req.openfortUserId;
    delete f.req.openfortAccessToken;
    await f.controller.markAgentRegistrationTransaction(f.req, { chainId: 84532, txHash: `0x${'a'.repeat(64)}` });
    expect(f.auth.markAgentRegistrationTransaction).toHaveBeenCalledWith('provider-1', 84532, `0x${'a'.repeat(64)}`, undefined);
  });
});
