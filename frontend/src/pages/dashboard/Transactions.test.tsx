import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppSessionProvider, useAppSession } from '@/components/AppSessionProvider';
import ProtectedRoute from '@/components/ProtectedRoute';
import TransactionsPage from './Transactions';
import type { AppSessionSnapshot } from '@/lib/api';

function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }
interface DeferredResponse {
  promise: Promise<Response>;
  resolve: (value: Response) => void;
  reject: (error: Error) => void;
}
function deferred(): DeferredResponse {
  // Node 20 (the supported CI runtime) has no Promise.withResolvers.
  let resolve!: DeferredResponse['resolve'];
  let reject!: DeferredResponse['reject'];
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const session: AppSessionSnapshot = {
  sessionId: 'history-session', userId: 'history-user', email: 'history@example.com',
  mfaVerified: true, csrfToken: 'history-csrf', expiresAt: new Date(Date.now() + 3600_000).toISOString(),
};
function item(id: string) {
  return { id, status: 'pending', txHash: null, chainId: 8453, walletAddress: '0x1234567890123456789012345678901234567890',
    operationType: 'send', type: 'typed_data', apiKeyName: id, apiKeyPrefix: null,
    createdAt: new Date().toISOString(), completedAt: null, failureReason: null };
}
function result(id: string, total = 1) { return json({ items: [item(id)], total, page: 1, limit: 20 }); }
function Controls() {
  const { refresh } = useAppSession();
  return <button onClick={() => { void refresh(); }}>Recheck session</button>;
}
function mountHistory() {
  return render(<MemoryRouter initialEntries={['/dashboard/transactions']}><AppSessionProvider>
    <Controls />
    <Routes><Route path="/dashboard/transactions" element={<ProtectedRoute><TransactionsPage /></ProtectedRoute>} /></Routes>
  </AppSessionProvider></MemoryRouter>);
}
const lists = [
  { tab: 'Transactions', path: '/transactions', status: 'Transaction status', chain: 'Transaction chain', detail: 'View transaction' },
  { tab: 'Signing Requests', path: '/wallets/signing-requests', status: 'Signing request status', chain: 'Signing request chain', detail: 'View signing request' },
] as const;

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', ''); }) });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.removeAttribute('open'); }) });
});

describe.each(lists)('$tab request ownership', (list) => {
  it('ignores stale errors, stale success and stale loading across filters and refresh', async () => {
    const requests: Array<DeferredResponse & { signal: AbortSignal; url: URL }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/auth/session')) return Promise.resolve(json(session));
      if (url.pathname.endsWith(list.path)) {
        const pending = deferred();
        requests.push({ ...pending, signal: init?.signal as AbortSignal, url });
        return pending.promise; // Deliberately ignore abort, like an already-delivered response.
      }
      return Promise.resolve(json({ items: [], total: 0 }));
    });
    mountHistory();
    await screen.findByRole('heading', { name: 'History' });
    if (list.tab !== 'Transactions') fireEvent.click(screen.getByRole('button', { name: list.tab }));
    await waitFor(() => expect(requests).toHaveLength(1));
    fireEvent.change(screen.getByLabelText(list.status), { target: { value: 'failed' } });
    expect(requests[0].signal.aborted).toBe(true);
    expect(requests[1].url.searchParams.get('status')).toBe('failed');
    await act(async () => { requests[0].reject(new Error('stale list failure')); });
    expect(screen.queryByText('stale list failure')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    await act(async () => { requests[1].resolve(result('filtered')); });
    expect(screen.getByRole('button', { name: `${list.detail} filtered` })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    fireEvent.change(screen.getByLabelText(list.chain), { target: { value: '8453' } });
    expect(requests[2].signal.aborted).toBe(true);
    expect(requests[3].url.searchParams.get('chainId')).toBe('8453');
    await act(async () => { requests[3].resolve(result('newest', 41)); });
    await act(async () => { requests[2].resolve(result('stale')); });
    expect(screen.getByRole('button', { name: `${list.detail} newest` })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `${list.detail} stale` })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    expect(requests[4].url.searchParams.get('page')).toBe('2');
    fireEvent.change(screen.getByLabelText(list.status), { target: { value: '' } });
    expect(requests[4].signal.aborted).toBe(true);
    expect(requests[5].url.searchParams.get('page')).toBe('1');
    await act(async () => { requests[5].resolve(result('first-page')); requests[4].resolve(result('old-page')); });
    expect(screen.getByRole('button', { name: `${list.detail} first-page` })).toBeInTheDocument();
    expect(screen.queryByText('old-page')).not.toBeInTheDocument();
  });

  it('aborts a pending list on tab change and unmount', async () => {
    const signals: AbortSignal[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/auth/session')) return Promise.resolve(json(session));
      if (url.pathname.endsWith(list.path)) {
        signals.push(init?.signal as AbortSignal);
        return new Promise<Response>(() => undefined);
      }
      return Promise.resolve(json({ items: [], total: 0 }));
    });
    const view = mountHistory();
    await screen.findByRole('heading', { name: 'History' });
    if (list.tab !== 'Transactions') fireEvent.click(screen.getByRole('button', { name: list.tab }));
    await waitFor(() => expect(signals).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: list.tab === 'Transactions' ? 'Signing Requests' : 'Transactions' }));
    expect(signals[0].aborted).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: list.tab }));
    expect(signals).toHaveLength(2);
    view.unmount();
    expect(signals[1].aborted).toBe(true);
  });

  it('provides a native keyboard detail button, focuses its modal and restores the opener', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/auth/session')) return json(session);
      if (url.pathname.endsWith('/transactions') || url.pathname.endsWith('/wallets/signing-requests')) return result('keyboard-record');
      return json({ ...item('keyboard-record'), authMethod: 'api_key', withdrawal: null, idempotencyKey: null });
    });
    mountHistory();
    await screen.findByRole('heading', { name: 'History' });
    if (list.tab !== 'Transactions') fireEvent.click(screen.getByRole('button', { name: list.tab }));
    const opener = await screen.findByRole('button', { name: `${list.detail} keyboard-record` });
    expect(opener.tagName).toBe('BUTTON');
    opener.focus();
    await user.keyboard('{Enter}');
    const dialog = screen.getByRole('dialog');
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalled();
    expect(within(dialog).getByRole('button', { name: 'Close drawer' })).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
    await user.keyboard(' ');
    // Escape's native default action is not implemented by jsdom; its cancel
    // event is exercised here, and native focus containment in browser smoke.
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(opener).toHaveFocus();
  });
});

it('does not reload history on same-session rechecks but isolates an actual identity switch', async () => {
  let current = session;
  const requests: Array<DeferredResponse & { signal: AbortSignal }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.endsWith('/auth/session')) return Promise.resolve(json(current));
    const pending = deferred();
    requests.push({ ...pending, signal: init?.signal as AbortSignal });
    return pending.promise;
  });
  mountHistory();
  await waitFor(() => expect(requests).toHaveLength(1));
  await act(async () => { fireEvent.click(screen.getByText('Recheck session')); });
  expect(requests).toHaveLength(1);
  current = { ...session, sessionId: 'different-session', userId: 'different-user', csrfToken: 'different-csrf' };
  await act(async () => { fireEvent.click(screen.getByText('Recheck session')); });
  expect(requests).toHaveLength(2);
  expect(requests[0].signal.aborted).toBe(true);
  await act(async () => { requests[1].resolve(result('new-account')); requests[0].resolve(result('old-account')); });
  expect(screen.getByRole('button', { name: 'View transaction new-account' })).toBeInTheDocument();
  expect(screen.queryByText('old-account')).not.toBeInTheDocument();
});
