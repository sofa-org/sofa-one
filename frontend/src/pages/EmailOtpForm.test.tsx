import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import EmailOtpForm from './EmailOtpForm';

const mocks = vi.hoisted(() => ({ request: vi.fn(), verify: vi.fn(), token: vi.fn(), exchange: vi.fn() }));
vi.mock('@openfort/react', () => ({
  useEmailOtpAuth: () => ({ requestEmailOtp: mocks.request, signInEmailOtp: mocks.verify, isRequesting: false, isLoading: false }),
  useUser: () => ({ getAccessToken: mocks.token }),
}));
vi.mock('@/components/AppSessionProvider', () => ({ useAppSession: () => ({ exchange: mocks.exchange }) }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.request.mockResolvedValue({});
  mocks.verify.mockResolvedValue({ user: { id: 'provider-user' } });
  mocks.token.mockResolvedValue('fresh-provider-bearer');
  mocks.exchange.mockResolvedValue({ sessionId: 'session-1', mfaVerified: false });
});

function renderForm(walletReauthentication = false) {
  render(<MemoryRouter initialEntries={['/sign-in']}><Routes>
    <Route path="/sign-in" element={<EmailOtpForm walletReauthentication={walletReauthentication} />} />
    <Route path="/dashboard" element={<p>Dashboard destination</p>} />
  </Routes></MemoryRouter>);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'user@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send OTP' }));
}
async function verifyCode() {
  await screen.findByRole('button', { name: 'Verify code' });
  const inputs = screen.getAllByRole('textbox');
  fireEvent.change(inputs[1], { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify code' }));
}

describe('email OTP application-session exchange', () => {
  it('waits for backend cookie exchange before navigating', async () => {
    // This package targets ES2020, before Promise.withResolvers is available.
    let resolveExchange: ((value: { sessionId: string }) => void) | undefined;
    mocks.exchange.mockImplementationOnce(() => new Promise<{ sessionId: string }>((resolve) => { resolveExchange = resolve; }));
    renderForm();
    await verifyCode();
    await waitFor(() => expect(mocks.exchange).toHaveBeenCalledWith('fresh-provider-bearer'));
    expect(screen.queryByText('Dashboard destination')).not.toBeInTheDocument();
    await act(async () => { resolveExchange?.({ sessionId: 'session-1' }); });
    expect(await screen.findByText('Dashboard destination')).toBeInTheDocument();
  });
  it('keeps sign-in available with an error when cookie exchange fails', async () => {
    mocks.exchange.mockRejectedValueOnce(new Error('Session service unavailable'));
    renderForm();
    await verifyCode();
    expect(await screen.findByText('Session service unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Dashboard destination')).not.toBeInTheDocument();
  });
  it('does not exchange or navigate when provider identity token is unavailable', async () => {
    mocks.token.mockResolvedValueOnce(null);
    renderForm();
    await verifyCode();
    expect(await screen.findByText('Identity verification is not ready. Try the code again.')).toBeInTheDocument();
    expect(mocks.exchange).not.toHaveBeenCalled();
  });
  it('reconnects wallet identity without replacing the existing app session', async () => {
    renderForm(true);
    await verifyCode();
    await waitFor(() => expect(mocks.token).toHaveBeenCalledTimes(1));
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(screen.queryByText('Dashboard destination')).not.toBeInTheDocument();
  });
});
