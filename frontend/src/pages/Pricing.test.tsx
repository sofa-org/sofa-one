import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useAppSession } from '@/components/AppSessionProvider';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PricingPage from './Pricing';
import { getBillingPlansAuth, type AppSessionSnapshot } from '@/lib/api';

vi.mock('@/components/AppSessionProvider', () => ({
  useAppSession: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    getBillingPlansAuth: vi.fn(),
  };
});

function LocationStateProbe() {
  const location = useLocation();
  return (
    <div
      data-testid="location-probe"
      data-pathname={location.pathname}
      data-search={location.search}
      data-hash={location.hash}
      data-state={JSON.stringify(location.state ?? null)}
    />
  );
}

function PricingRoutes({ initialPath = '/pricing' }: { initialPath?: string }) {
  return (
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/sign-in" element={<LocationStateProbe />} />
        <Route path="/dashboard/billing" element={<LocationStateProbe />} />
      </Routes>
    </MemoryRouter>
  );
}

function renderPricing(initialPath = '/pricing') {
  return render(<PricingRoutes initialPath={initialPath} />);
}

const fullSession: AppSessionSnapshot = {
  sessionId: 'session_1',
  userId: 'user_1',
  email: 'user@example.com',
  mfaVerified: true,
  expiresAt: '2026-10-22T12:00:00.000Z',
  csrfToken: 'test-csrf',
};

function mockSession(over: { session?: AppSessionSnapshot | null; loading?: boolean } = {}) {
  vi.mocked(useAppSession).mockReturnValue({
    session: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
    exchange: vi.fn(),
    signOut: vi.fn(),
    signOutAll: vi.fn(),
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSession();
  vi.mocked(getBillingPlansAuth).mockResolvedValue({
    currentPlanId: 'starter',
    plans: [],
  });
});

describe('Pricing — logged-in current plan highlight', () => {
  it('marks the canonical current plan and suppresses Growth "Most popular"', async () => {
    mockSession({ session: fullSession });
    vi.mocked(getBillingPlansAuth).mockResolvedValue({
      currentPlanId: 'starter',
      plans: [],
    });

    renderPricing();

    // Starter becomes "Current plan" only after auth settles + billing plans resolve.
    expect(await screen.findByText('Current plan')).toBeInTheDocument();
    expect(screen.queryByText('Most popular')).not.toBeInTheDocument();

    const manageBilling = screen.getByRole('link', { name: /Manage billing on SOFA ONE/i });
    expect(manageBilling).toHaveAttribute(
      'href',
      '/dashboard/billing?plan=starter#choose-a-plan',
    );

    // Non-current cards keep their marketing CTAs; Growth is not "most popular".
    expect(screen.getByRole('link', { name: /Get Growth on SOFA ONE/i })).toBeInTheDocument();
    expect(getBillingPlansAuth).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it('keeps public pricing while a session is pending MFA', async () => {
    mockSession({ session: { ...fullSession, mfaVerified: false } });
    const view = renderPricing();

    expect(screen.getByText('Most popular')).toBeInTheDocument();
    expect(screen.queryByText('Current plan')).not.toBeInTheDocument();
    expect(getBillingPlansAuth).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: /Get Starter on SOFA ONE/i })).toHaveAttribute(
      'href',
      '/dashboard/billing?plan=starter#choose-a-plan',
    );

    mockSession({ session: fullSession });
    view.rerender(<PricingRoutes />);

    expect(await screen.findByText('Current plan')).toBeInTheDocument();
    expect(getBillingPlansAuth).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it('does not fetch private pricing until session loading settles', () => {
    mockSession({ session: fullSession, loading: true });
    renderPricing();

    expect(screen.getByText('Most popular')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'SIGN IN' })).not.toBeInTheDocument();
    expect(getBillingPlansAuth).not.toHaveBeenCalled();
  });

  it('keeps public pricing if the private plan fetch fails', async () => {
    mockSession({ session: fullSession });
    vi.mocked(getBillingPlansAuth).mockRejectedValue(new Error('Unavailable'));
    renderPricing();

    await waitFor(() => expect(getBillingPlansAuth).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Most popular')).toBeInTheDocument();
    expect(screen.queryByText('Current plan')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Get Starter on SOFA ONE/i })).toHaveAttribute(
      'href',
      '/dashboard/billing?plan=starter#choose-a-plan',
    );
  });

  it('clears the private current-plan highlight when the session ends', async () => {
    mockSession({ session: fullSession });
    const view = renderPricing();
    expect(await screen.findByText('Current plan')).toBeInTheDocument();

    mockSession();
    view.rerender(<PricingRoutes />);

    expect(screen.queryByText('Current plan')).not.toBeInTheDocument();
    expect(screen.getByText('Most popular')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Get Starter on SOFA ONE/i })).toHaveAttribute(
      'href',
      '/sign-in',
    );
    expect(getBillingPlansAuth).toHaveBeenCalledTimes(1);
  });
});

describe('Pricing — anonymous CTAs and Enterprise mailto', () => {
  it('sends plan CTAs to sign-in with billing deep-link return state', async () => {
    mockSession();
    renderPricing();

    // Anonymous visitors always see marketing CTAs (no current-plan fetch).
    const starterCta = await screen.findByRole('link', { name: /Get Starter on SOFA ONE/i });
    expect(starterCta).toHaveAttribute('href', '/sign-in');

    fireEvent.click(starterCta);

    const probe = await screen.findByTestId('location-probe');
    expect(probe).toHaveAttribute('data-pathname', '/sign-in');

    const state = JSON.parse(probe.getAttribute('data-state') ?? 'null') as {
      from?: { pathname?: string; search?: string; hash?: string };
    } | null;
    expect(state?.from).toEqual({
      pathname: '/dashboard/billing',
      search: '?plan=starter',
      hash: '#choose-a-plan',
    });
  });

  it('keeps Enterprise on a sales mailto and never routes through billing', async () => {
    mockSession();
    renderPricing();

    const enterprise = await screen.findByRole('link', {
      name: /Contact sales for SOFA ONE Enterprise/i,
    });
    expect(enterprise.getAttribute('href')).toBe(
      'mailto:sales@sofa.one?subject=SOFA%20ONE%20Enterprise%20pricing',
    );
    expect(enterprise.getAttribute('href')).not.toContain('/dashboard/billing');
    expect(enterprise.getAttribute('href')).not.toBe('/sign-in');
  });

  it('does not fetch billing plans while the visitor is anonymous', async () => {
    mockSession();
    renderPricing();

    await screen.findByRole('link', { name: /Get Starter on SOFA ONE/i });
    await waitFor(() => {
      expect(getBillingPlansAuth).not.toHaveBeenCalled();
    });
  });
});
