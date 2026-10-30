import { lazy, Suspense, type ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppSessionProvider } from '@/components/AppSessionProvider';
import ProtectedRoute from '@/components/ProtectedRoute';
import DashboardLayout from './DashboardLayout';

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    if (url.pathname.endsWith('/auth/session')) return new Response(JSON.stringify({
      sessionId: 'shell-session', userId: 'shell-user', email: 'shell@example.com', mfaVerified: true,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), csrfToken: 'shell-csrf',
    }));
    return new Response('[]');
  });
});
function mountPage(page: ReactNode) {
  return render(<MemoryRouter initialEntries={['/dashboard/transactions']}><AppSessionProvider>
    <Suspense fallback={<p>Whole app loading</p>}>
      <Routes>
        <Route path="/dashboard" element={<ProtectedRoute><DashboardLayout /></ProtectedRoute>}>
          <Route path="transactions" element={page} />
          <Route path="docs" element={<h1>API reference content</h1>} />
        </Route>
        <Route path="/sign-in" element={<h1>Signed out</h1>} />
      </Routes>
    </Suspense>
  </AppSessionProvider></MemoryRouter>);
}

it('keeps navigation and logout mounted while a lazy child suspends', async () => {
  const SlowPage = lazy(() => new Promise<{ default: () => ReactNode }>(() => undefined));
  mountPage(<SlowPage />);
  expect(await screen.findByRole('status')).toHaveTextContent('Loading page');
  expect(screen.queryByText('Whole app loading')).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'API Docs' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
  fireEvent.click(screen.getByRole('link', { name: 'API Docs' }));
  expect(await screen.findByRole('heading', { name: 'API reference content' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(await screen.findByRole('heading', { name: 'Signed out' })).toBeInTheDocument();
  const fetchMock = vi.mocked(globalThis.fetch);
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
});

it('contains a rejected child chunk and resets its error boundary on navigation', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const BrokenPage = lazy(async () => { throw new Error('chunk download unavailable'); });
  mountPage(<BrokenPage />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
  fireEvent.click(screen.getByRole('link', { name: 'API Docs' }));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(screen.getByRole('heading', { name: 'API reference content' })).toBeInTheDocument();
});

it('can revoke a session without waiting for a suspended child', async () => {
  const SlowPage = lazy(() => new Promise<{ default: () => ReactNode }>(() => undefined));
  mountPage(<SlowPage />);
  await screen.findByRole('status');
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(await screen.findByRole('heading', { name: 'Signed out' })).toBeInTheDocument();
});
