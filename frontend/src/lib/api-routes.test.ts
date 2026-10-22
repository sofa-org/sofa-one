import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Api from './api';

describe.each([
  { mode: 'Vite proxy', apiUrl: undefined, base: '/api' },
  { mode: 'configured API URL', apiUrl: 'http://localhost:3100', base: 'http://localhost:3100' },
])('canonical API route transports ($mode)', ({ apiUrl, base }) => {
  let api: typeof Api;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('VITE_API_URL', apiUrl);
    // API_BASE is captured at module load, so import only after setting each case's environment.
    api = await import('./api');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('sends API-key transactions to the canonical resource path', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await api.sendTransactionWithApiKey('sk_test', { chainId: 84532, idempotencyKey: 'stable', interactions: [] });
    expect(fetchMock.mock.calls[0][0]).toBe(`${base}/v1/transactions`);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: expect.objectContaining({ 'X-API-Key': 'sk_test' }) });
  });

  it('preserves distinct wallet and signer addresses in EOA signing responses', async () => {
    const response: Api.SignResponse = {
      signature: '0x1234',
      walletAddress: '0x1111111111111111111111111111111111111111',
      signerAddress: '0x2222222222222222222222222222222222222222',
      executionMode: 'eoa',
      type: 'typed_data',
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
    const request: Api.SignRequest = {
      type: 'typed_data',
      executionMode: 'eoa',
      typedData: {
        domain: { name: 'ClobAuthDomain', version: '1', chainId: 137 },
        types: { ClobAuth: [
          { name: 'address', type: 'address' },
          { name: 'timestamp', type: 'string' },
          { name: 'nonce', type: 'uint256' },
          { name: 'message', type: 'string' },
        ] },
        primaryType: 'ClobAuth',
        message: {
          address: response.signerAddress,
          timestamp: String(Math.floor(Date.now() / 1000)),
          nonce: 0,
          message: 'This message attests that I control the given wallet',
        },
      },
    };
    const result = await api.signWithApiKey('sk_test', request);
    expect(fetchMock.mock.calls[0][0]).toBe(`${base}/v1/wallets/sign`);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: expect.objectContaining({ 'X-API-Key': 'sk_test' }) });
    expect(result).toEqual(response);
    expect(result.walletAddress).not.toBe(result.signerAddress);
    expect(result).not.toHaveProperty('agentWalletAddress');
  });

  it('uses cookie credentials without a provider bearer for dashboard reads', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await api.getDepositInfoAuth(84532, '00000000-0000-4000-8000-000000000001');
    expect(fetchMock.mock.calls[0][0]).toBe(`${base}/wallets/deposits?chainId=84532&walletId=00000000-0000-4000-8000-000000000001`);
    const init = fetchMock.mock.calls[0][1];
    expect(init?.credentials).toBe('include');
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
  });

  it('uses an explicit identity bearer only for session exchange and wallet authorization', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}'));
    await api.exchangeAppSession('fresh-identity');
    await api.authorizeEmbeddedWallet('fresh-wallet-identity', { embeddedWalletAddress: '0x1111111111111111111111111111111111111111' });
    expect(fetchMock.mock.calls[0][0]).toBe(`${base}/auth/session`);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer fresh-identity');
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('Authorization')).toBe('Bearer fresh-wallet-identity');
    expect(fetchMock.mock.calls.every(([, init]) => init?.credentials === 'include')).toBe(true);
  });

  it('sends CSRF and step-up for unsafe dashboard calls, preserving withdrawal retry keys', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}'));
    api.configureAppSessionTransport('csrf-secret');
    await api.refreshApiKey('proof', 'wallet-id');
    const input = ['0x1111111111111111111111111111111111111111', '100', 'USDC', 84532, 'proof', undefined, 'stable-retry-key'] as const;
    await api.withdrawAuth(...input);
    await api.withdrawAuth(...input);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.credentials).toBe('include');
      const headers = new Headers(init?.headers);
      expect(headers.get('X-CSRF-Token')).toBe('csrf-secret');
      expect(headers.get('X-Step-Up-Token')).toBe('proof');
      expect(headers.has('Authorization')).toBe(false);
    }
    expect(fetchMock.mock.calls.slice(1).map(([, init]) => JSON.parse(String(init?.body)).idempotencyKey)).toEqual(['stable-retry-key', 'stable-retry-key']);
  });

  it('restores, upgrades MFA, and revokes sessions through cookie endpoints', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}'));
    api.configureAppSessionTransport('csrf-secret');
    await api.getAppSession();
    await api.getMfaStatusAuth();
    await api.verifyTotpAuth('123456');
    await api.deleteAppSession();
    await api.deleteAllAppSessions('proof');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${base}/auth/session`, `${base}/auth/mfa/status`, `${base}/auth/mfa/totp/verify`,
      `${base}/auth/session`, `${base}/auth/sessions`,
    ]);
    expect(fetchMock.mock.calls[0][1]?.cache).toBe('no-store');
    expect(fetchMock.mock.calls[3][1]?.method).toBe('DELETE');
    expect(fetchMock.mock.calls[4][1]?.method).toBe('DELETE');
    expect(new Headers(fetchMock.mock.calls[4][1]?.headers).get('X-Step-Up-Token')).toBe('proof');
  });

  it('preserves app authentication when only the separate wallet identity fails', async () => {
    const invalidate = vi.fn();
    api.configureAppSessionTransport('csrf-secret', invalidate);
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'AUTH_PROVIDER_INVALID' }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'AUTH_PROVIDER_UNAVAILABLE' }), { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'AUTHENTICATION_REQUIRED' }), { status: 401 }));
    const body = { embeddedWalletAddress: '0x1111111111111111111111111111111111111111' };
    await expect(api.authorizeEmbeddedWallet('expired-provider', body)).rejects.toMatchObject({ code: 'AUTH_PROVIDER_INVALID' });
    expect(invalidate).not.toHaveBeenCalled();
    await expect(api.authorizeEmbeddedWallet('fresh-provider', body)).rejects.toMatchObject({ code: 'AUTH_PROVIDER_UNAVAILABLE' });
    expect(invalidate).not.toHaveBeenCalled();
    await expect(api.authorizeEmbeddedWallet('fresh-provider', body)).rejects.toBeInstanceOf(api.ApiError);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('invalidates local authentication only on dashboard 401, not 403 or outages', async () => {
    const invalidate = vi.fn();
    api.configureAppSessionTransport('csrf-secret', invalidate);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    for (const status of [403, 503, 401]) {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status }));
      await expect(api.getBillingPlansAuth()).rejects.toBeInstanceOf(api.ApiError);
      expect(invalidate).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    }
  });
});
