import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useOpenfort, useUser } from '@openfort/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PricingPage from './Pricing';
import { getBillingPlansAuth } from '@/lib/api';

// Openfort hooks only — Pricing never mounts the real SDK when AuthProviders is stubbed.
vi.mock('@openfort/react', () => ({
  useOpenfort: vi.fn(),
  useUser: vi.fn(),
}));

// Avoid wiring the real Openfort/wagmi stack; Pricing only needs a provider boundary.
vi.mock('../components/AuthProviders', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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

function renderPricing(initialPath = '/pricing') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/sign-in" element={<LocationStateProbe />} />
        <Route path="/dashboard/billing" element={<LocationStateProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

function mockAuth(over: {
  isLoading?: boolean;
  user?: { id: string } | null;
  getAccessToken?: () => Promise<string | null>;
} = {}) {
  vi.mocked(useOpenfort).mockReturnValue({
    isLoading: over.isLoading ?? false,
    user: over.user === undefined ? null : over.user,
  } as ReturnType<typeof useOpenfort>);

  vi.mocked(useUser).mockReturnValue({
    getAccessToken: over.getAccessToken ?? vi.fn().mockResolvedValue('test-token'),
  } as ReturnType<typeof useUser>);
}

beforeEach(() => {
  mockAuth({ user: null });
  vi.mocked(getBillingPlansAuth).mockResolvedValue({
    currentPlanId: 'starter',
    plans: [],
  });
});

describe('Pricing — logged-in current plan highlight', () => {
  it('marks the canonical current plan and suppresses Growth "Most popular"', async () => {
    mockAuth({ user: { id: 'user_1' } });
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
  });
});

describe('Pricing — anonymous CTAs and Enterprise mailto', () => {
  it('sends plan CTAs to sign-in with billing deep-link return state', async () => {
    mockAuth({ user: null });
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
    mockAuth({ user: null });
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
    mockAuth({ user: null });
    renderPricing();

    await screen.findByRole('link', { name: /Get Starter on SOFA ONE/i });
    await waitFor(() => {
      expect(getBillingPlansAuth).not.toHaveBeenCalled();
    });
  });
});
