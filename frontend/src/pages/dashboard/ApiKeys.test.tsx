import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppSessionProvider } from '@/components/AppSessionProvider';
import ApiKeysPage from './ApiKeys';
import { requestStepUpToken } from './step-up';

vi.mock('./step-up', () => ({ requestStepUpToken: vi.fn(async () => 'proof') }));

function json(value: unknown) { return new Response(JSON.stringify(value)); }

beforeEach(() => { vi.clearAllMocks(); window.localStorage.clear(); window.sessionStorage.clear(); });

async function mountKeys() {
  const create = vi.fn();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path.endsWith('/auth/session')) return json({ sessionId: 'keys-session', userId: 'user', email: 'keys@example.com', mfaVerified: true, csrfToken: 'csrf', expiresAt: new Date(Date.now() + 3600000).toISOString() });
    if (path.endsWith('/auth/me')) return json({ wallets: [{ id: 'wallet', isDefault: true, walletAddress: '0x1111111111111111111111111111111111111111', status: 'active' }] });
    if (path.endsWith('/defi-capabilities')) return json({ capabilities: [] });
    if (path.endsWith('/defi-capability-bundles')) return json({ schemaVersion: 1, currentCatalogManifestHash: 'manifest', bundles: [] });
    if (path.endsWith('/api-keys') && init?.method === 'POST') {
      create(JSON.parse(String(init.body)));
      return json({ rawKey: 'sk_test', expiresAt: new Date(Date.now() + 86400000).toISOString() });
    }
    return json([]);
  });
  render(<MemoryRouter><AppSessionProvider><ApiKeysPage /></AppSessionProvider></MemoryRouter>);
  fireEvent.change(await screen.findByPlaceholderText('e.g. Production Backend'), { target: { value: 'Backend' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Create Key' })).toBeEnabled());
  return create;
}

describe('API key creation and first request', () => {
  it.each(['Sign typed data', 'Send transactions', 'Use EOA signing'])('requires backend IPs before step-up for %s', async (permission) => {
    const create = await mountKeys();
    fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(permission) }));
    fireEvent.click(screen.getByRole('button', { name: 'Create Key' }));
    const field = screen.getByLabelText('IP allowlist');
    expect(field).toBeRequired();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field.closest('details')).toHaveAttribute('open');
    expect(field).toHaveFocus();
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(requestStepUpToken).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('allows a read-only key without an IP allowlist', async () => {
    const create = await mountKeys();
    expect(screen.getByLabelText('IP allowlist')).not.toBeRequired();
    fireEvent.click(screen.getByRole('button', { name: 'Create Key' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ permissions: { canSign: false, canSendTransaction: false, canReadTransactionStatus: true, canUseEoaExecution: false } })));
    expect(create.mock.calls[0][0]).not.toHaveProperty('allowedIps');
    expect(requestStepUpToken).toHaveBeenCalledOnce();
  });
});
