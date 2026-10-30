import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppSessionProvider, useAppSession } from './AppSessionProvider';
import ProtectedRoute from './ProtectedRoute';
import PublicOnlyRoute from './PublicOnlyRoute';
import DashboardStepUpGate from './DashboardStepUpGate';
import { getBillingPlansAuth, type AppSessionSnapshot } from '@/lib/api';
import { bindDashboardStepUpSession, getDashboardStepUpToken, storeDashboardStepUpProof } from '@/pages/dashboard/step-up-session';

vi.mock('qrcode', () => ({ toDataURL: vi.fn(async () => 'data:image/png;base64,qr') }));

function snapshot(overrides: Partial<AppSessionSnapshot> = {}): AppSessionSnapshot {
  return { sessionId: 'session-1', userId: 'user-1', email: 'user@example.com', mfaVerified: true,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), csrfToken: 'csrf-1', ...overrides };
}
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }

function SessionControls() {
  const { session, refresh, exchange, signOut, signOutAll } = useAppSession();
  return <>
    <span data-testid="session-id">{session?.sessionId ?? 'absent'}</span>
    <button onClick={() => { void refresh().catch(() => undefined); }}>Refresh session</button>
    <button onClick={() => { void exchange('fresh-provider-bearer').catch(() => undefined); }}>Exchange identity</button>
    <button onClick={() => { void signOut().catch(() => undefined); }}>Current logout</button>
    <button onClick={() => { void signOutAll('step-up-proof').catch(() => undefined); }}>All logout</button>
    <button onClick={() => { void getBillingPlansAuth().catch(() => undefined); }}>Business request</button>
  </>;
}
function renderSession(gate = false) {
  return render(<MemoryRouter initialEntries={['/dashboard/docs']}><AppSessionProvider>
    <SessionControls />
    <Routes>
      <Route path="/dashboard/docs" element={<ProtectedRoute>{gate
        ? <DashboardStepUpGate><p>Business content</p></DashboardStepUpGate>
        : <p>Business content</p>}</ProtectedRoute>} />
      <Route path="/sign-in" element={<PublicOnlyRoute><p>Email sign-in</p></PublicOnlyRoute>} />
    </Routes>
  </AppSessionProvider></MemoryRouter>);
}

beforeEach(() => {
  window.sessionStorage.clear();
  bindDashboardStepUpSession(null);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('application session boundary without Openfort context', () => {
  it('restores a full server session and opens non-wallet content without a proof cache', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(snapshot()));
    renderSession(true);
    expect(await screen.findByText('Business content')).toBeInTheDocument();
    expect(getDashboardStepUpToken()).toBeNull();
  });

  it('does not grant authentication from a cached proof when the server has no session', async () => {
    window.sessionStorage.setItem('sofa-one:dashboard-step-up', JSON.stringify({ sessionId: 'session-1', proofToken: 'cached', expiresAt: new Date(Date.now() + 600_000).toISOString() }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({}, 401));
    renderSession(true);
    expect(await screen.findByText('Email sign-in')).toBeInTheDocument();
    expect(screen.queryByText('Business content')).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem('sofa-one:dashboard-step-up')).toBeNull();
  });

  it('keeps a pending MFA session behind verification even with a matching cached proof', async () => {
    window.sessionStorage.setItem('sofa-one:dashboard-step-up', JSON.stringify({ sessionId: 'session-1', proofToken: 'cached', expiresAt: new Date(Date.now() + 600_000).toISOString() }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => String(url).endsWith('/auth/session')
      ? json(snapshot({ mfaVerified: false })) : json({ enabled: true, recoveryCodesRemaining: 5 }));
    renderSession(true);
    expect(await screen.findByText('Verify your authenticator code')).toBeInTheDocument();
    expect(screen.queryByText('Business content')).not.toBeInTheDocument();
  });

  it('preserves the session through a 503 and allows retry without signing out', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(snapshot()));
    renderSession();
    await screen.findByText('Business content');
    fetchMock.mockResolvedValueOnce(json({ message: 'Temporarily unavailable' }, 503));
    fireEvent.click(screen.getByText('Refresh session'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Temporarily unavailable');
    expect(screen.getByText('Business content')).toBeInTheDocument();
    expect(screen.getByTestId('session-id')).toHaveTextContent('session-1');
    fetchMock.mockResolvedValueOnce(json(snapshot()));
    fireEvent.click(screen.getByText('Retry session check'));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('shows a retry instead of redirecting on an initial server outage', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({}, 503));
    renderSession();
    expect(await screen.findByText('Session check unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Email sign-in')).not.toBeInTheDocument();
    fetchMock.mockResolvedValueOnce(json(snapshot()));
    fireEvent.click(screen.getByText('Retry session check'));
    expect(await screen.findByText('Business content')).toBeInTheDocument();
  });

  it('clears session and proofs on a dashboard 401, not a 403', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(snapshot()));
    renderSession();
    await screen.findByText('Business content');
    storeDashboardStepUpProof({ proofToken: 'proof', expiresAt: new Date(Date.now() + 600_000).toISOString() }, 'session-1');
    fetchMock.mockResolvedValueOnce(json({}, 403));
    fireEvent.click(screen.getByText('Business request'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Business content')).toBeInTheDocument();
    fetchMock.mockResolvedValueOnce(json({}, 401));
    fireEvent.click(screen.getByText('Business request'));
    expect(await screen.findByText('Email sign-in')).toBeInTheDocument();
    expect(getDashboardStepUpToken()).toBeNull();
  });

  it('exchanges explicit provider identity and clears proofs when session identity changes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(snapshot()));
    renderSession();
    await screen.findByText('Business content');
    storeDashboardStepUpProof({ proofToken: 'old-proof', expiresAt: new Date(Date.now() + 600_000).toISOString() }, 'session-1');
    fetchMock.mockResolvedValueOnce(json(snapshot({ sessionId: 'session-2', csrfToken: 'csrf-2', mfaVerified: false })));
    fireEvent.click(screen.getByText('Exchange identity'));
    await waitFor(() => expect(screen.getByTestId('session-id')).toHaveTextContent('session-2'));
    expect(getDashboardStepUpToken()).toBeNull();
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('Authorization')).toBe('Bearer fresh-provider-bearer');
  });

  it('does not let focus or visibility reads discard a successful login exchange', async () => {
    let completeExchange!: (response: Response) => void;
    const exchangeResponse = new Promise<Response>((resolve) => { completeExchange = resolve; });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({}, 401))
      .mockReturnValueOnce(exchangeResponse)
      .mockResolvedValueOnce(json({}, 401));
    renderSession();
    await screen.findByText('Email sign-in');
    fireEvent.click(screen.getByText('Exchange identity'));
    fireEvent.focus(window);
    fireEvent(document, new Event('visibilitychange'));
    await act(async () => {
      completeExchange(json(snapshot({ sessionId: 'new-login', csrfToken: 'new-csrf' })));
    });
    expect(await screen.findByText('Business content')).toBeInTheDocument();
    expect(screen.getByTestId('session-id')).toHaveTextContent('new-login');
  });

  it('coalesces focus, visibility and manual refresh, then allows another security check', async () => {
    let complete!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { complete = resolve; });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(snapshot())).mockReturnValueOnce(pending);
    renderSession();
    await screen.findByText('Business content');
    fireEvent.focus(window);
    fireEvent(document, new Event('visibilitychange'));
    fireEvent.click(screen.getByText('Refresh session'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { complete(json(snapshot({ csrfToken: 'rotated-csrf' }))); });
    fetchMock.mockResolvedValueOnce(json({}, 401));
    fireEvent.click(screen.getByText('Refresh session'));
    expect(await screen.findByText('Email sign-in')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('releases a failed shared refresh so retry still rechecks security state', async () => {
    let complete!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { complete = resolve; });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(snapshot())).mockReturnValueOnce(pending);
    renderSession();
    await screen.findByText('Business content');
    fireEvent.focus(window);
    fireEvent.click(screen.getByText('Refresh session'));
    await act(async () => { complete(json({ message: 'Security check offline' }, 503)); });
    expect(screen.getByRole('alert')).toHaveTextContent('Security check offline');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockResolvedValueOnce(json(snapshot()));
    fireEvent.click(screen.getByText('Retry session check'));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not accept an ordinary refresh from before a newer login exchange', async () => {
    let completeOld!: (value: Response) => void;
    const old = new Promise<Response>((resolve) => { completeOld = resolve; });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(snapshot()))
      .mockReturnValueOnce(old)
      .mockResolvedValueOnce(json(snapshot({ sessionId: 'replacement', csrfToken: 'replacement-csrf' })));
    renderSession();
    await screen.findByText('Business content');
    fireEvent.click(screen.getByText('Refresh session'));
    fireEvent.click(screen.getByText('Exchange identity'));
    await waitFor(() => expect(screen.getByTestId('session-id')).toHaveTextContent('replacement'));
    await act(async () => { completeOld(json(snapshot())); });
    expect(screen.getByTestId('session-id')).toHaveTextContent('replacement');
  });

  it.each(['Current logout', 'All logout'])('never restores an old refresh after %s', async (control) => {
    let completeOld!: (value: Response) => void;
    const old = new Promise<Response>((resolve) => { completeOld = resolve; });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(snapshot()))
      .mockReturnValueOnce(old)
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    renderSession();
    await screen.findByText('Business content');
    fireEvent.click(screen.getByText('Refresh session'));
    fireEvent.click(screen.getByText(control));
    await screen.findByText('Email sign-in');
    await act(async () => { completeOld(json(snapshot())); });
    expect(screen.getByTestId('session-id')).toHaveTextContent('absent');
    expect(screen.queryByText('Business content')).not.toBeInTheDocument();
  });

  it('enforces a same-session MFA downgrade on focus and clears its old proof', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(snapshot()));
    renderSession(true);
    await screen.findByText('Business content');
    storeDashboardStepUpProof({ proofToken: 'old-proof', expiresAt: new Date(Date.now() + 600_000).toISOString() }, 'session-1');
    fetchMock.mockResolvedValueOnce(json(snapshot({ mfaVerified: false })))
      .mockResolvedValueOnce(json({ enabled: true, recoveryCodesRemaining: 5 }));
    fireEvent.focus(window);
    expect(await screen.findByText('Verify your authenticator code')).toBeInTheDocument();
    expect(screen.queryByText('Business content')).not.toBeInTheDocument();
    expect(getDashboardStepUpToken()).toBeNull();
  });

  it.each(['Current logout', 'All logout'])('revokes %s before clearing local authentication', async (control) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(snapshot()));
    renderSession();
    await screen.findByText('Business content');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    fireEvent.click(screen.getByText(control));
    expect(await screen.findByText('Email sign-in')).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toMatch(control === 'All logout' ? /\/auth\/sessions$/ : /\/auth\/session$/);
    expect(init?.method).toBe('DELETE');
    expect(init?.credentials).toBe('include');
    expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('csrf-1');
    if (control === 'All logout') expect(new Headers(init?.headers).get('X-Step-Up-Token')).toBe('step-up-proof');
  });

  it('preserves authentication when backend logout fails', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(snapshot()));
    renderSession();
    await screen.findByText('Business content');
    fetchMock.mockResolvedValueOnce(json({}, 503));
    fireEvent.click(screen.getByText('Current logout'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Business content')).toBeInTheDocument();
  });

  it('expires the absolute local snapshot and clears cached proofs without sliding renewal', async () => {
    vi.useFakeTimers();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(snapshot({ expiresAt })));
    await act(async () => { renderSession(); });
    expect(screen.getByText('Business content')).toBeInTheDocument();
    storeDashboardStepUpProof({ proofToken: 'proof', expiresAt }, 'session-1');
    await act(async () => { vi.advanceTimersByTime(60_001); });
    expect(screen.getByTestId('session-id')).toHaveTextContent('absent');
    expect(getDashboardStepUpToken()).toBeNull();
  });

  it('refreshes the server MFA upgrade but retains recovery codes until acknowledgement', async () => {
    let full = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const path = String(url);
      if (path.endsWith('/auth/session')) return json(snapshot({ mfaVerified: full }));
      if (path.endsWith('/auth/mfa/status')) return json({ enabled: false, recoveryCodesRemaining: 0 });
      if (path.endsWith('/auth/mfa/totp/setup')) return json({ secret: 'SECRET', otpauthUrl: 'otpauth://totp/SOFA?secret=SECRET' });
      if (path.endsWith('/auth/mfa/totp/enable')) return json({ recoveryCodes: ['ABCD-EFGH-JKLM'] });
      if (path.endsWith('/auth/mfa/totp/verify')) {
        expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('csrf-1');
        full = true;
        return json({ proofToken: 'verified-proof', expiresAt: new Date(Date.now() + 600_000).toISOString() });
      }
      throw new Error(`Unexpected request ${path}`);
    });
    renderSession(true);
    await screen.findByText('Set up authenticator-based MFA');
    for (let index = 1; index <= 6; index += 1) fireEvent.change(screen.getByLabelText(`Authenticator code digit ${index}`), { target: { value: String(index) } });
    fireEvent.click(screen.getByRole('button', { name: 'Enable MFA' }));
    expect(await screen.findByRole('button', { name: 'Continue to dashboard' })).toBeInTheDocument();
    expect(screen.getByText('ABCD-EFGH-JKLM')).toBeInTheDocument();
    expect(screen.queryByText('Business content')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to dashboard' }));
    expect(await screen.findByText('Business content')).toBeInTheDocument();
    expect(getDashboardStepUpToken()).toBe('verified-proof');
  });
});
