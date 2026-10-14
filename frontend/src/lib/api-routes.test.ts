import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDepositInfoAuth, getMfaStatusAuth, refreshApiKey, sendTransactionWithApiKey, syncSession, withdrawAuth } from './api';

describe('canonical API route transports', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends API-key transactions to the canonical resource path', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await sendTransactionWithApiKey('sk_test', { chainId: 84532, idempotencyKey: 'stable', interactions: [] } as any);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/transactions');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: expect.objectContaining({ 'X-API-Key': 'sk_test' }) });
  });

  it('uses validated GET query parameters for deposit info', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await getDepositInfoAuth(async () => 'iam-token', 84532, '00000000-0000-4000-8000-000000000001');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/wallets/deposits?chainId=84532&walletId=00000000-0000-4000-8000-000000000001');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: expect.objectContaining({ Authorization: 'Bearer iam-token' }) });
  });

  it('uses the canonical unversioned auth path and bearer token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await syncSession(async () => 'iam-token');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/session');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer iam-token' }) });
  });

  it('uses canonical unversioned MFA paths', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await getMfaStatusAuth(async () => 'iam-token');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/mfa/status');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: expect.objectContaining({ Authorization: 'Bearer iam-token' }) });
  });

  it('rotates keys through the dashboard command with step-up and posts withdrawals canonically', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await refreshApiKey(async () => 'iam-token', 'proof', 'wallet-id');
    const input = [async () => 'iam-token', '0x1111111111111111111111111111111111111111', '100', 'USDC', 84532, 'proof', undefined, 'stable-retry-key'] as const;
    await withdrawAuth(...input);
    await withdrawAuth(...input);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/api-keys/rotations');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer iam-token', 'X-Step-Up-Token': 'proof' }) });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/wallets/withdrawals');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer iam-token', 'X-Step-Up-Token': 'proof' }) });
    expect(fetchMock.mock.calls.slice(1).map(([, init]) => JSON.parse(String(init?.body)).idempotencyKey)).toEqual(['stable-retry-key', 'stable-retry-key']);
  });
});
