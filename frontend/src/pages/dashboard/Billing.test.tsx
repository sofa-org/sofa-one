import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useUser } from '@openfort/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import BillingPage from './Billing';
import {
  assignBillingPlanAuth,
  createBillingCheckoutSessionAuth,
  getBillingPlansAuth,
  getBillingSummaryAuth,
  listBillingInvoicesAuth,
  type BillingInvoice,
  type BillingInvoicesResponse,
  type BillingPlan,
} from '@/lib/api';
import {
  apiError,
  invoicesResponse,
  makeInvoice,
  makePaidInvoice,
  makePayableInvoice,
  makePlans,
  makeSummary,
} from '@/test/billing-helpers';

// Mirrors the bounded payment-confirmation polling contract implemented in Billing.tsx.
const PENDING_INVOICE_STORAGE_KEY = 'sofa-one.billing.pendingInvoiceId';
const POLL_INTERVAL_MS = 1500;
const MAX_POLL_ATTEMPTS = 6;

// Narrowly mock the Openfort IAM hook; the Billing page only reads these fields.
vi.mock('@openfort/react', () => ({ useUser: vi.fn() }));

// Mock the API layer, keeping ApiError/isApiError/getApiErrorMessage real so the page's
// error mapping (friendly checkout errors, plan-change messages, retry surfaces) is exercised.
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    getBillingPlansAuth: vi.fn(),
    getBillingSummaryAuth: vi.fn(),
    listBillingInvoicesAuth: vi.fn(),
    createBillingCheckoutSessionAuth: vi.fn(),
    getBillingInvoicePdfAuth: vi.fn(),
    assignBillingPlanAuth: vi.fn(),
  };
});

// Isolate the Billing page's observable contract from the (separately tested) USDC panel
// internals. The stub surfaces the onChange plumbing so tests can drive the silent invoice
// refresh exactly like a real panel would.
vi.mock('./UsdcPaymentPanel', () => {
  function UsdcPaymentPanelStub({
    invoice,
    onChange,
  }: {
    invoice: { id: string };
    onChange: () => boolean | Promise<boolean>;
  }) {
    return (
      <div data-testid="usdc-panel">
        <span data-testid="usdc-panel-invoice">{invoice.id}</span>
        <button type="button" onClick={() => void onChange()}>
          refresh invoice
        </button>
      </div>
    );
  }
  return { UsdcPaymentPanel: UsdcPaymentPanelStub };
});

function LocationProbe() {
  const location = useLocation();
  return (
    <>
      <div data-testid="location-search">{location.search}</div>
      <div data-testid="location-hash">{location.hash}</div>
    </>
  );
}

function renderBilling(initialPath = '/dashboard/billing') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <BillingPage />
      <LocationProbe />
    </MemoryRouter>,
  );
}

function mockUseUser(
  over: Partial<{
    isAuthenticated: boolean;
    isLoading: boolean;
    getAccessToken: () => Promise<string | null>;
  }> = {},
) {
  vi.mocked(useUser).mockReturnValue({
    getAccessToken: over.getAccessToken ?? vi.fn().mockResolvedValue('test-token'),
    isAuthenticated: over.isAuthenticated ?? true,
    isLoading: over.isLoading ?? false,
  } as ReturnType<typeof useUser>);
}

/** A module-scoped list backing the invoice API mock so tests can flip invoice state. */
let currentInvoices: BillingInvoice[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Flush pending microtasks/timers under fake timers, inside act. */
async function flushTimers() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  currentInvoices = [];
  sessionStorage.clear();
  mockUseUser();
  vi.mocked(getBillingPlansAuth).mockResolvedValue(makePlans());
  vi.mocked(getBillingSummaryAuth).mockResolvedValue(makeSummary());
  vi.mocked(listBillingInvoicesAuth).mockImplementation(async () =>
    invoicesResponse(currentInvoices),
  );
  vi.mocked(createBillingCheckoutSessionAuth).mockResolvedValue({
    invoiceId: 'inv_1',
    sessionId: 'cs_1',
    checkoutUrl: 'https://checkout.stripe.example/start',
  });
  vi.mocked(assignBillingPlanAuth).mockResolvedValue({
    planCode: 'plan_pro',
    planName: 'Pro',
    effectivePeriod: '2026-09',
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    outcome: 'scheduled',
    changeId: 'chg_down_1',
    kind: 'downgrade',
  });
});

describe('Billing — Stripe return markers and query cleanup', () => {
  it('shows the processing notice and strips the success param after ?success=1', async () => {
    vi.useFakeTimers();
    currentInvoices = [makePayableInvoice('inv_1')];
    renderBilling('/dashboard/billing?success=1');

    // The return-marker effect runs synchronously in render's act.
    expect(screen.getByText('Payment processing')).toBeInTheDocument();
    expect(
      screen.getByText(
        /We're checking for confirmation and will update the invoice automatically/i,
      ),
    ).toBeInTheDocument();

    await flushTimers();

    // Query is cleaned regardless of polling state.
    expect(screen.getByTestId('location-search')).toHaveTextContent('');
    // Still unpaid & payable → the notice remains 'processing' while polling is bounded.
    expect(screen.getByText('Payment processing')).toBeInTheDocument();
  });

  it('shows the returned-to-billing notice, strips the query, and does not poll after ?canceled=1', async () => {
    vi.useFakeTimers();
    currentInvoices = [makePayableInvoice('inv_1')];
    renderBilling('/dashboard/billing?canceled=1');

    expect(screen.getByText('Returned to billing')).toBeInTheDocument();
    expect(screen.queryByText('Payment processing')).not.toBeInTheDocument();
    expect(screen.queryByText('Waiting for confirmation')).not.toBeInTheDocument();

    await flushTimers();
    expect(screen.getByTestId('location-search')).toHaveTextContent('');

    // Cancel re-fetches invoices once (initial load + the canceled refresh).
    expect(vi.mocked(listBillingInvoicesAuth).mock.calls.length).toBe(2);
    expect(vi.getTimerCount()).toBe(0);

    // No polling was started: nothing fires even well after the marker.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(vi.mocked(listBillingInvoicesAuth).mock.calls.length).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('prefers success over canceled when both markers are present', async () => {
    vi.useFakeTimers();
    currentInvoices = [makePayableInvoice('inv_1')];
    renderBilling('/dashboard/billing?success=1&canceled=1');

    expect(screen.getByText('Payment processing')).toBeInTheDocument();
    expect(screen.queryByText('Returned to billing')).not.toBeInTheDocument();

    await flushTimers();
    expect(screen.getByTestId('location-search')).toHaveTextContent('');
  });

  it('shows no notice and does not poll when there are no return markers', async () => {
    vi.useFakeTimers();
    currentInvoices = [makePayableInvoice('inv_1')];
    renderBilling();

    await flushTimers();
    expect(vi.mocked(listBillingInvoicesAuth).mock.calls.length).toBe(1);

    expect(screen.queryByText('Payment processing')).not.toBeInTheDocument();
    expect(screen.queryByText('Returned to billing')).not.toBeInTheDocument();
    expect(screen.queryByText('Waiting for confirmation')).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores success=0: no processing notice and no polling is started', async () => {
    vi.useFakeTimers();
    currentInvoices = [makePayableInvoice('inv_1')];
    renderBilling('/dashboard/billing?success=0');

    await flushTimers();

    expect(screen.queryByText('Payment processing')).not.toBeInTheDocument();
    expect(screen.queryByText('Payment confirmed')).not.toBeInTheDocument();
    expect(screen.queryByText('Waiting for confirmation')).not.toBeInTheDocument();
    expect(screen.queryByText('Returned to billing')).not.toBeInTheDocument();
    // A non-"1" marker is not a truthful return: the URL is left untouched and nothing polls.
    expect(screen.getByTestId('location-search')).toHaveTextContent('success=0');
    expect(vi.getTimerCount()).toBe(0);
    expect(vi.mocked(listBillingInvoicesAuth).mock.calls.length).toBe(1);
  });

  it('ignores canceled=0: no returned-to-billing notice and no extra refresh', async () => {
    vi.useFakeTimers();
    currentInvoices = [makePayableInvoice('inv_1')];
    renderBilling('/dashboard/billing?canceled=0');

    await flushTimers();

    expect(screen.queryByText('Returned to billing')).not.toBeInTheDocument();
    expect(screen.queryByText('Payment processing')).not.toBeInTheDocument();
    expect(screen.queryByText('Payment confirmed')).not.toBeInTheDocument();
    expect(screen.getByTestId('location-search')).toHaveTextContent('canceled=0');
    expect(vi.getTimerCount()).toBe(0);
    // Only the initial load — the canceled-triggered refresh must not run.
    expect(vi.mocked(listBillingInvoicesAuth).mock.calls.length).toBe(1);
  });
});

describe('Billing — bounded payment-confirmation polling', () => {
  it('confirms payment and stops polling once the tracked invoice is paid', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem(PENDING_INVOICE_STORAGE_KEY, 'inv_1');
    currentInvoices = [makePayableInvoice('inv_1')];
    renderBilling('/dashboard/billing?success=1');

    expect(screen.getByText('Payment processing')).toBeInTheDocument();
    await flushTimers();

    // Server now reports the invoice paid; the next poll cycle detects it.
    currentInvoices = [makePaidInvoice('inv_1')];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);
    });

    expect(screen.getByText('Payment confirmed')).toBeInTheDocument();
    expect(screen.queryByText('Payment processing')).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
    expect(sessionStorage.getItem(PENDING_INVOICE_STORAGE_KEY)).toBeNull();

    // No hanging timers or further requests.
    const settledCalls = vi.mocked(listBillingInvoicesAuth).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(vi.mocked(listBillingInvoicesAuth).mock.calls.length).toBe(settledCalls);
  });

  it('keeps checking through the bounded budget when the tracked invoice is absent, then settles with a terminal timeout', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem(PENDING_INVOICE_STORAGE_KEY, 'inv_1');
    currentInvoices = []; // tracked invoice not on the first page / nothing payable
    renderBilling('/dashboard/billing?success=1');

    expect(screen.getByText('Payment processing')).toBeInTheDocument();
    await flushTimers();

    // Absence of the tracked invoice on the first page is ambiguous, so the flow is not
    // settled early — it keeps checking within its bounded budget.
    expect(screen.queryByText('Waiting for confirmation')).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20 * POLL_INTERVAL_MS);
    });

    expect(screen.getByText('Waiting for confirmation')).toBeInTheDocument();
    expect(
      screen.getByText(/still waiting for the final payment confirmation/i),
    ).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
    expect(sessionStorage.getItem(PENDING_INVOICE_STORAGE_KEY)).toBeNull();

    const settledCalls = vi.mocked(listBillingInvoicesAuth).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(vi.mocked(listBillingInvoicesAuth).mock.calls.length).toBe(settledCalls);
  });

  it('gives up after the bounded attempt budget while the invoice stays payable (no hang)', async () => {
    vi.useFakeTimers();
    currentInvoices = [makePayableInvoice('inv_1')];
    renderBilling('/dashboard/billing?success=1');

    expect(screen.getByText('Payment processing')).toBeInTheDocument();
    await flushTimers();

    // Advance well past the poll budget; the page must stop on its own.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * POLL_INTERVAL_MS);
    });

    expect(screen.getByText('Waiting for confirmation')).toBeInTheDocument();
    expect(
      screen.getByText(/still waiting for the final payment confirmation/i),
    ).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);

    // Exactly the initial load + one attempt per poll cycle, then nothing more.
    const totalCalls = vi.mocked(listBillingInvoicesAuth).mock.calls.length;
    expect(totalCalls).toBeLessThanOrEqual(1 + MAX_POLL_ATTEMPTS);
    expect(totalCalls).toBeGreaterThanOrEqual(1 + 2); // initial load + at least two poll cycles

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(vi.mocked(listBillingInvoicesAuth).mock.calls.length).toBe(totalCalls);
  });

  it('aborts any in-flight polling when the page unmounts (no stale updates)', async () => {
    vi.useFakeTimers();
    currentInvoices = [makePayableInvoice('inv_1')];
    const view = renderBilling('/dashboard/billing?success=1');

    expect(screen.getByText('Payment processing')).toBeInTheDocument();
    await flushTimers();
    expect(vi.getTimerCount()).toBe(1); // a poll cycle is scheduled

    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(vi.getTimerCount()).toBe(0);
  });

  it('reaches a bounded terminal state after polling refreshes keep failing, and later focus/visibility does not resume polling', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem(PENDING_INVOICE_STORAGE_KEY, 'inv_1');
    currentInvoices = [makePayableInvoice('inv_1')];

    // Every invoice request fails: the initial load and all polling refreshes.
    vi.mocked(listBillingInvoicesAuth).mockRejectedValue(apiError(500));

    renderBilling('/dashboard/billing?success=1');
    expect(screen.getByText('Payment processing')).toBeInTheDocument();
    await flushTimers();

    // A single failing refresh does not settle the flow — polling stays bounded and keeps trying.
    expect(screen.queryByText('Waiting for confirmation')).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    // Exhaust the whole attempt budget with failing refreshes.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20 * POLL_INTERVAL_MS);
    });

    // Bounded terminal state with a truthful timeout notice…
    expect(screen.getByText('Waiting for confirmation')).toBeInTheDocument();
    expect(
      screen.getByText(/still waiting for the final payment confirmation/i),
    ).toBeInTheDocument();
    // …and full teardown: no timers and no pending marker left behind.
    expect(vi.getTimerCount()).toBe(0);
    expect(sessionStorage.getItem(PENDING_INVOICE_STORAGE_KEY)).toBeNull();

    const settledCalls = vi.mocked(listBillingInvoicesAuth).mock.calls.length;

    // Later focus/visibility must not schedule polls beyond the budget.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(vi.mocked(listBillingInvoicesAuth).mock.calls.length).toBe(settledCalls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not let a late initial invoices load overwrite a fresher polling response showing the tracked invoice paid', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem(PENDING_INVOICE_STORAGE_KEY, 'inv_1');
    currentInvoices = [makePayableInvoice('inv_1')];

    const deferreds: Array<{ resolve: (value: BillingInvoicesResponse) => void }> = [];
    vi.mocked(listBillingInvoicesAuth).mockImplementation(() => {
      const d = deferred<BillingInvoicesResponse>();
      deferreds.push({ resolve: d.resolve });
      return d.promise;
    });

    renderBilling('/dashboard/billing?success=1');
    await flushTimers();

    // Call #1 is the first polling cycle (superseded by the initial load at mount);
    // call #2 is the initial load.
    expect(deferreds.length).toBe(2);

    // Cycle-1 resolves after being aborted, so it only schedules the next poll.
    await act(async () => {
      deferreds[0].resolve(invoicesResponse([makePayableInvoice('inv_1')]));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);
    });
    // Cycle-2's refresh is now in flight.
    expect(deferreds.length).toBe(3);

    // The fresher polling response reports the tracked invoice paid.
    await act(async () => {
      deferreds[2].resolve(invoicesResponse([makePaidInvoice('inv_1')]));
    });
    expect(screen.getByText('Payment confirmed')).toBeInTheDocument();
    expect(sessionStorage.getItem(PENDING_INVOICE_STORAGE_KEY)).toBeNull();

    // The initial load now resolves late with a stale unpaid snapshot; it must not
    // overwrite the paid result.
    await act(async () => {
      deferreds[1].resolve(invoicesResponse([makePayableInvoice('inv_1')]));
    });

    expect(screen.getByText('Payment confirmed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Card' })).not.toBeInTheDocument();
    expect(sessionStorage.getItem(PENDING_INVOICE_STORAGE_KEY)).toBeNull();
  });

  it('clears the initial invoice spinner when a current polling response supersedes it', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem(PENDING_INVOICE_STORAGE_KEY, 'inv_1');
    currentInvoices = [makePayableInvoice('inv_1')];

    const deferreds: Array<{ resolve: (value: BillingInvoicesResponse) => void }> = [];
    vi.mocked(listBillingInvoicesAuth).mockImplementation(() => {
      const d = deferred<BillingInvoicesResponse>();
      deferreds.push({ resolve: d.resolve });
      return d.promise;
    });

    const view = renderBilling('/dashboard/billing?success=1');
    await flushTimers();
    expect(deferreds.length).toBe(2); // polling refresh + initial load

    // Let the superseded first poll resolve so the bounded polling loop can
    // schedule its next cycle while the initial load remains unresolved.
    await act(async () => {
      deferreds[0].resolve(invoicesResponse([makePayableInvoice('inv_1')]));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);
    });
    expect(deferreds.length).toBe(3);

    // The current poll returns an unpaid invoice. It is still the authoritative
    // current snapshot, so the invoice table must leave its initial spinner even
    // though the stale initial request is still pending.
    await act(async () => {
      deferreds[2].resolve(invoicesResponse([makePayableInvoice('inv_1')]));
    });

    expect(screen.getByRole('button', { name: 'Card' })).toBeInTheDocument();
    view.unmount();
  });

  it('keeps the tracked polling flow alive when the tracked invoice is pending and an unrelated invoice in the first page is payable', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem(PENDING_INVOICE_STORAGE_KEY, 'inv_tracked');
    currentInvoices = [makePayableInvoice('inv_tracked'), makePayableInvoice('inv_unrelated')];
    renderBilling('/dashboard/billing?success=1');
    await flushTimers();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * POLL_INTERVAL_MS);
    });

    // The unrelated payable invoice must not terminate the tracked flow.
    expect(screen.queryByText('Waiting for confirmation')).not.toBeInTheDocument();
    expect(screen.getByText('Payment processing')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    // The tracked flow is still bounded: it gives up after the attempt budget.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20 * POLL_INTERVAL_MS);
    });
    expect(screen.getByText('Waiting for confirmation')).toBeInTheDocument();
    expect(
      screen.getByText(/still waiting for the final payment confirmation/i),
    ).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
    expect(sessionStorage.getItem(PENDING_INVOICE_STORAGE_KEY)).toBeNull();
  });

  it('confirms the tracked invoice paid even while an unrelated invoice in the first page is still payable', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem(PENDING_INVOICE_STORAGE_KEY, 'inv_tracked');
    currentInvoices = [makePayableInvoice('inv_tracked'), makePayableInvoice('inv_unrelated')];
    renderBilling('/dashboard/billing?success=1');
    await flushTimers();

    currentInvoices = [makePaidInvoice('inv_tracked'), makePayableInvoice('inv_unrelated')];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);
    });

    expect(screen.getByText('Payment confirmed')).toBeInTheDocument();
    expect(screen.queryByText('Waiting for confirmation')).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
    expect(sessionStorage.getItem(PENDING_INVOICE_STORAGE_KEY)).toBeNull();
  });

  it('keeps polling through the budget when the tracked invoice is absent from the first page but another invoice is payable', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem(PENDING_INVOICE_STORAGE_KEY, 'inv_tracked');
    currentInvoices = [makePayableInvoice('inv_unrelated')];
    renderBilling('/dashboard/billing?success=1');
    await flushTimers();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * POLL_INTERVAL_MS);
    });

    // Absence of the tracked invoice is ambiguous, so the flow keeps polling instead of
    // settling early on the unrelated payable invoice.
    expect(screen.queryByText('Waiting for confirmation')).not.toBeInTheDocument();
    expect(screen.getByText('Payment processing')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20 * POLL_INTERVAL_MS);
    });
    expect(screen.getByText('Waiting for confirmation')).toBeInTheDocument();
    expect(
      screen.getByText(/still waiting for the final payment confirmation/i),
    ).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
    expect(sessionStorage.getItem(PENDING_INVOICE_STORAGE_KEY)).toBeNull();
  });

  it('settles the tracked flow when the tracked invoice is visible but no longer payable', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem(PENDING_INVOICE_STORAGE_KEY, 'inv_tracked');
    currentInvoices = [
      makeInvoice({ id: 'inv_tracked', status: 'void', amount: '10.00', currency: 'USD' }),
    ];
    renderBilling('/dashboard/billing?success=1');
    await flushTimers();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);
    });

    expect(screen.getByText('Waiting for confirmation')).toBeInTheDocument();
    expect(
      screen.getByText(/will keep updating automatically as the payment clears/i),
    ).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts in-flight invoice requests on unmount so a late response cannot apply stale state', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem(PENDING_INVOICE_STORAGE_KEY, 'inv_1');
    currentInvoices = [makePayableInvoice('inv_1')];

    const deferreds: Array<{ resolve: (value: BillingInvoicesResponse) => void }> = [];
    const signals: Array<AbortSignal | undefined> = [];
    vi.mocked(listBillingInvoicesAuth).mockImplementation((_token, _params, signal) => {
      signals.push(signal);
      const d = deferred<BillingInvoicesResponse>();
      deferreds.push({ resolve: d.resolve });
      return d.promise;
    });

    const view = renderBilling('/dashboard/billing?success=1');
    await flushTimers();
    expect(deferreds.length).toBe(2); // polling refresh + initial load in flight

    view.unmount();

    // Every in-flight invoice request is aborted — the cleanup is not just timer teardown.
    expect(signals.length).toBe(2);
    expect(signals.every((s) => s?.aborted)).toBe(true);

    // Late resolution must not resurrect stale state or throw.
    await act(async () => {
      for (const d of deferreds) {
        d.resolve(invoicesResponse([makePaidInvoice('inv_1')]));
      }
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Billing — open invoice UX', () => {
  it('explains finalized vs open invoices and shows a non-interactive finalization hint for open rows', async () => {
    currentInvoices = [
      makeInvoice({
        id: 'inv_open',
        status: 'open',
        amount: '10.00',
        currency: 'USD',
      }),
    ];
    renderBilling();

    expect(
      await screen.findByText(/Finalized invoices can be paid by Card or USDC/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Open invoices are estimates for the current period/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /payment options appear after the period ends and the invoice is finalized/i,
      ),
    ).toBeInTheDocument();

    const finalizationHint = await screen.findByLabelText('Available after finalization');
    expect(finalizationHint).toHaveTextContent('Available after finalization');

    // Open invoices must not expose payment actions or call checkout/USDC.
    expect(screen.queryByRole('button', { name: 'Card' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'USDC' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Subscribe' })).not.toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
    expect(createBillingCheckoutSessionAuth).not.toHaveBeenCalled();
  });
});

describe('Billing — invoice payment actions and user-visible errors', () => {
  let locationStub: { href: string };
  beforeEach(() => {
    locationStub = { href: '' };
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: locationStub,
    });
  });

  it('opens Stripe card checkout, records the pending invoice, and redirects to the server URL', async () => {
    currentInvoices = [makePayableInvoice('inv_1')];
    renderBilling();

    fireEvent.click(await screen.findByRole('button', { name: 'Card' }));

    await waitFor(() =>
      expect(createBillingCheckoutSessionAuth).toHaveBeenCalledWith(expect.any(Function), 'inv_1'),
    );
    expect(sessionStorage.getItem(PENDING_INVOICE_STORAGE_KEY)).toBe('inv_1');
    expect(locationStub.href).toBe('https://checkout.stripe.example/start');
  });

  it('surfaces a friendly message when card checkout is temporarily unavailable (503) and stays usable', async () => {
    currentInvoices = [makePayableInvoice('inv_1')];
    vi.mocked(createBillingCheckoutSessionAuth).mockRejectedValue(apiError(503));

    renderBilling();
    fireEvent.click(await screen.findByRole('button', { name: 'Card' }));

    expect(
      await screen.findByText('Checkout is temporarily unavailable. Please try again in a moment.'),
    ).toBeInTheDocument();
    // No hang: loading state cleared and the button is usable again.
    expect(screen.queryByText('Redirecting…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Card' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(
      screen.queryByText('Checkout is temporarily unavailable. Please try again in a moment.'),
    ).not.toBeInTheDocument();
  });

  it('keeps a 409 card-checkout error user-visible without hanging', async () => {
    currentInvoices = [makePayableInvoice('inv_1')];
    vi.mocked(createBillingCheckoutSessionAuth).mockRejectedValue(
      apiError(409, { code: 'INVOICE_CONFLICT', message: 'Invoice is no longer payable.' }),
    );

    renderBilling();
    fireEvent.click(await screen.findByRole('button', { name: 'Card' }));

    expect(
      await screen.findByText('Could not start checkout. Please check the invoice and try again.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Redirecting…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Card' })).toBeEnabled();
  });

  it('shows Card and USDC only on finalized invoices — never a separate Subscribe action', async () => {
    currentInvoices = [
      makeInvoice({
        id: 'inv_plan',
        status: 'finalized',
        amount: '49.00',
        currency: 'USD',
        planVersionId: 'pv_1',
      }),
    ];
    renderBilling();

    expect(await screen.findByRole('button', { name: 'Card' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'USDC' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Subscribe' })).not.toBeInTheDocument();
  });

  it('pays a finalized plan invoice with one-time card checkout even when planVersionId is present', async () => {
    currentInvoices = [
      makeInvoice({
        id: 'inv_plan',
        status: 'finalized',
        amount: '49.00',
        currency: 'USD',
        planVersionId: 'pv_1',
      }),
    ];
    renderBilling();

    fireEvent.click(await screen.findByRole('button', { name: 'Card' }));

    await waitFor(() =>
      expect(createBillingCheckoutSessionAuth).toHaveBeenCalledWith(
        expect.any(Function),
        'inv_plan',
      ),
    );
    expect(sessionStorage.getItem(PENDING_INVOICE_STORAGE_KEY)).toBe('inv_plan');
    expect(locationStub.href).toBe('https://checkout.stripe.example/start');
  });

  it('does not start card checkout when the user only opens USDC', async () => {
    currentInvoices = [
      makeInvoice({
        id: 'inv_plan',
        status: 'finalized',
        amount: '49.00',
        currency: 'USD',
        planVersionId: 'pv_1',
      }),
    ];
    renderBilling();

    fireEvent.click(await screen.findByRole('button', { name: 'USDC' }));
    expect(screen.getByTestId('usdc-panel-invoice')).toHaveTextContent('inv_plan');
    expect(createBillingCheckoutSessionAuth).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(PENDING_INVOICE_STORAGE_KEY)).toBeNull();
    expect(locationStub.href).toBe('');
  });

  it('keeps an invoice-load 409 visible with a working retry', async () => {
    vi.useFakeTimers();
    currentInvoices = [makePayableInvoice('inv_1')];
    vi.mocked(listBillingInvoicesAuth).mockRejectedValueOnce(
      apiError(409, { message: 'Conflict while loading invoices.' }),
    );

    renderBilling();

    await flushTimers();
    expect(screen.getByText('Conflict while loading invoices.')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await flushTimers();

    // Retry uses the default (working) mock and the payable invoice renders again.
    expect(screen.getByRole('button', { name: 'Card' })).toBeInTheDocument();
    expect(screen.queryByText('Conflict while loading invoices.')).not.toBeInTheDocument();
  });
});

describe('Billing — USDC panel lifecycle', () => {
  it('opens the panel for a payable invoice and auto-closes it once the invoice is paid', async () => {
    currentInvoices = [makePayableInvoice('inv_1')];
    renderBilling();

    fireEvent.click(await screen.findByRole('button', { name: 'USDC' }));
    expect(screen.getByTestId('usdc-panel-invoice')).toHaveTextContent('inv_1');

    // Server now reports the invoice paid; the panel's onChange triggers a silent refresh.
    currentInvoices = [makePaidInvoice('inv_1')];
    fireEvent.click(screen.getByRole('button', { name: /refresh invoice/i }));

    await waitFor(() => expect(screen.queryByTestId('usdc-panel-invoice')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'USDC' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Paid').length).toBeGreaterThan(0);
  });

  it('keeps the panel open when a refresh still reports the invoice unpaid', async () => {
    currentInvoices = [makePayableInvoice('inv_1')];
    renderBilling();

    fireEvent.click(await screen.findByRole('button', { name: 'USDC' }));
    expect(screen.getByTestId('usdc-panel-invoice')).toHaveTextContent('inv_1');

    fireEvent.click(screen.getByRole('button', { name: /refresh invoice/i }));
    await waitFor(() => expect(vi.mocked(listBillingInvoicesAuth).mock.calls.length).toBe(2));

    expect(screen.getByTestId('usdc-panel-invoice')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('swallows a silent-refresh error: the panel stays open and the table is not replaced by an error', async () => {
    currentInvoices = [makePayableInvoice('inv_1')];
    renderBilling();

    fireEvent.click(await screen.findByRole('button', { name: 'USDC' }));
    expect(screen.getByTestId('usdc-panel-invoice')).toHaveTextContent('inv_1');

    vi.mocked(listBillingInvoicesAuth).mockRejectedValueOnce(apiError(500));
    fireEvent.click(screen.getByRole('button', { name: /refresh invoice/i }));

    await waitFor(() => expect(vi.mocked(listBillingInvoicesAuth).mock.calls.length).toBe(2));

    expect(screen.getByTestId('usdc-panel-invoice')).toBeInTheDocument();
    expect(screen.queryByText('Could not load invoices.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('ignores a stale silent refresh that resolves after a newer one (abort / last-write-wins)', async () => {
    currentInvoices = [makePayableInvoice('inv_1')];
    renderBilling();

    fireEvent.click(await screen.findByRole('button', { name: 'USDC' }));
    expect(screen.getByTestId('usdc-panel-invoice')).toHaveTextContent('inv_1');

    // Gate the next two silent refreshes so we control resolution order.
    const deferreds: Array<{ resolve: (value: BillingInvoicesResponse) => void }> = [];
    vi.mocked(listBillingInvoicesAuth).mockImplementation(() => {
      const d = deferred<BillingInvoicesResponse>();
      deferreds.push({ resolve: d.resolve });
      return d.promise;
    });

    fireEvent.click(screen.getByRole('button', { name: /refresh invoice/i })); // request A
    fireEvent.click(screen.getByRole('button', { name: /refresh invoice/i })); // request B (aborts A)

    // The newer response reports paid and closes the panel…
    await act(async () => {
      deferreds[1].resolve(invoicesResponse([makePaidInvoice('inv_1')]));
    });
    await waitFor(() => expect(screen.queryByTestId('usdc-panel-invoice')).not.toBeInTheDocument());

    // …then the stale, still-unpaid response resolves and must be ignored.
    await act(async () => {
      deferreds[0].resolve(invoicesResponse([makePayableInvoice('inv_1')]));
    });

    expect(screen.queryByTestId('usdc-panel-invoice')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'USDC' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Paid').length).toBeGreaterThan(0);
  });
});

describe('Billing — plan change', () => {
  const PENDING_PLAN_UPGRADE_STORAGE_KEY = 'sofa-one.billing.pendingPlanUpgrade';

  let locationStub: { href: string };
  beforeEach(() => {
    locationStub = { href: '' };
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: locationStub,
    });
  });

  it('schedules a downgrade and shows effective-date messaging without a payment panel', async () => {
    currentInvoices = [makePaidInvoice('inv_1')];
    // Current = Pro so Starter is a downgrade.
    vi.mocked(getBillingPlansAuth).mockResolvedValue({
      ...makePlans(),
      currentPlanId: 'plan_pro',
    });
    vi.mocked(assignBillingPlanAuth).mockResolvedValue({
      planCode: 'plan_starter',
      planName: 'Starter',
      effectivePeriod: '2026-09',
      effectiveFrom: '2026-09-01T00:00:00.000Z',
      outcome: 'scheduled',
      changeId: 'chg_down_1',
      kind: 'downgrade',
    });

    renderBilling();

    fireEvent.click(await screen.findByRole('button', { name: 'Schedule Starter' }));

    await waitFor(() =>
      expect(assignBillingPlanAuth).toHaveBeenCalledWith(expect.any(Function), 'plan_starter'),
    );
    expect(screen.getByText('Downgrade scheduled')).toBeInTheDocument();
    expect(screen.getByText(/Starter begins on/i)).toBeInTheDocument();
    expect(screen.queryByText('Payment required to upgrade')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pay with card' })).not.toBeInTheDocument();
  });

  it('handles same-plan unchanged responses idempotently', async () => {
    currentInvoices = [makePaidInvoice('inv_1')];
    renderBilling();

    expect(await screen.findByRole('button', { name: 'Current plan' })).toBeDisabled();
    expect(assignBillingPlanAuth).not.toHaveBeenCalled();
  });

  it('requires payment for an upgrade and keeps the current plan until confirmation', async () => {
    currentInvoices = [
      makeInvoice({
        id: 'inv_upgrade',
        status: 'finalized',
        amount: '12.50',
        currency: 'USD',
        period: '2026-08',
      }),
    ];
    vi.mocked(assignBillingPlanAuth).mockResolvedValue({
      planCode: 'plan_pro',
      planName: 'Pro',
      effectivePeriod: '2026-08',
      effectiveFrom: '2026-08-01T00:00:00.000Z',
      outcome: 'payment_required',
      changeId: 'chg_up_1',
      invoiceId: 'inv_upgrade',
      amount: '12.50',
      currency: 'USD',
      kind: 'upgrade',
    });

    renderBilling();

    fireEvent.click(await screen.findByRole('button', { name: 'Upgrade to Pro' }));

    await waitFor(() =>
      expect(assignBillingPlanAuth).toHaveBeenCalledWith(expect.any(Function), 'plan_pro'),
    );

    expect(screen.getByText('Payment required to upgrade')).toBeInTheDocument();
    expect(screen.getByText(/Amount due: USD 12.50/i)).toBeInTheDocument();
    expect(screen.getByText('Payment required')).toBeInTheDocument();
    // Current plan remains Starter — never called active immediately.
    expect(screen.getAllByText('Current').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Current plan' })).toBeInTheDocument();
    expect(screen.queryByText('Upgrade activated')).not.toBeInTheDocument();

    const stored = sessionStorage.getItem(PENDING_PLAN_UPGRADE_STORAGE_KEY);
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored!).invoiceId).toBe('inv_upgrade');

    // Upgrade plan_charge uses the same one-time card checkout path — no Subscribe.
    expect(screen.queryByRole('button', { name: 'Subscribe' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pay with card' }));
    await waitFor(() =>
      expect(createBillingCheckoutSessionAuth).toHaveBeenCalledWith(
        expect.any(Function),
        'inv_upgrade',
      ),
    );
    expect(sessionStorage.getItem(PENDING_INVOICE_STORAGE_KEY)).toBe('inv_upgrade');
    expect(locationStub.href).toBe('https://checkout.stripe.example/start');
  });

  it('opens the existing USDC panel for the upgrade invoice id', async () => {
    currentInvoices = [
      makeInvoice({
        id: 'inv_upgrade',
        status: 'finalized',
        amount: '12.50',
        currency: 'USD',
      }),
    ];
    vi.mocked(assignBillingPlanAuth).mockResolvedValue({
      planCode: 'plan_pro',
      planName: 'Pro',
      effectivePeriod: '2026-08',
      effectiveFrom: '2026-08-01T00:00:00.000Z',
      outcome: 'payment_required',
      changeId: 'chg_up_1',
      invoiceId: 'inv_upgrade',
      amount: '12.50',
      currency: 'USD',
      kind: 'upgrade',
    });

    renderBilling();
    fireEvent.click(await screen.findByRole('button', { name: 'Upgrade to Pro' }));
    await screen.findByText('Payment required to upgrade');

    fireEvent.click(screen.getByRole('button', { name: 'Pay with USDC' }));
    expect(screen.getByTestId('usdc-panel-invoice')).toHaveTextContent('inv_upgrade');
  });

  it('shows pending activation after the upgrade invoice is paid while the current plan is unchanged', async () => {
    currentInvoices = [
      makeInvoice({
        id: 'inv_upgrade',
        status: 'finalized',
        amount: '12.50',
        currency: 'USD',
      }),
    ];
    sessionStorage.setItem(
      PENDING_PLAN_UPGRADE_STORAGE_KEY,
      JSON.stringify({
        invoiceId: 'inv_upgrade',
        planCode: 'plan_pro',
        planName: 'Pro',
        amount: '12.50',
        currency: 'USD',
        effectivePeriod: '2026-08',
        effectiveFrom: '2026-08-01T00:00:00.000Z',
      }),
    );

    renderBilling();
    expect(await screen.findByText(/Pay to upgrade to Pro/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Pay with USDC' }));
    expect(screen.getByTestId('usdc-panel-invoice')).toHaveTextContent('inv_upgrade');

    // Invoice paid; plans still report Starter (not yet activated).
    currentInvoices = [makePaidInvoice('inv_upgrade')];
    vi.mocked(getBillingPlansAuth).mockResolvedValue(makePlans());
    fireEvent.click(screen.getByRole('button', { name: /refresh invoice/i }));

    await waitFor(() => expect(screen.getByText('Upgrade activating')).toBeInTheDocument());
    expect(screen.getByText(/Payment received for Pro/i)).toBeInTheDocument();
    expect(screen.getByText(/not active yet/i)).toBeInTheDocument();
    expect(sessionStorage.getItem(PENDING_PLAN_UPGRADE_STORAGE_KEY)).toBeTruthy();
  });

  it('clears pending upgrade and shows activated once plans report the new current plan', async () => {
    currentInvoices = [makePaidInvoice('inv_upgrade')];
    sessionStorage.setItem(
      PENDING_PLAN_UPGRADE_STORAGE_KEY,
      JSON.stringify({
        invoiceId: 'inv_upgrade',
        planCode: 'plan_pro',
        planName: 'Pro',
        amount: '12.50',
        currency: 'USD',
        effectivePeriod: '2026-08',
        effectiveFrom: '2026-08-01T00:00:00.000Z',
      }),
    );
    vi.mocked(getBillingPlansAuth).mockResolvedValue({
      ...makePlans(),
      currentPlanId: 'plan_pro',
    });

    renderBilling();

    await waitFor(() => expect(screen.getByText('Upgrade activated')).toBeInTheDocument());
    expect(screen.getByText(/Pro is now your current plan/i)).toBeInTheDocument();
    expect(sessionStorage.getItem(PENDING_PLAN_UPGRADE_STORAGE_KEY)).toBeNull();
    expect(screen.queryByText(/Pay to upgrade to Pro/i)).not.toBeInTheDocument();
  });

  it('shows the backend error message when a plan change fails', async () => {
    currentInvoices = [makePaidInvoice('inv_1')];
    vi.mocked(assignBillingPlanAuth).mockRejectedValue(new Error('Plan is not available.'));

    renderBilling();

    fireEvent.click(await screen.findByRole('button', { name: 'Upgrade to Pro' }));

    expect(await screen.findByText('Plan is not available.')).toBeInTheDocument();
    expect(screen.getByText('Could not change plan')).toBeInTheDocument();
  });

  it('shows Card/USDC only on a pending upgrade charge invoice — never Subscribe', async () => {
    currentInvoices = [
      makeInvoice({
        id: 'inv_upgrade',
        status: 'finalized',
        amount: '12.50',
        currency: 'USD',
        planVersionId: 'pv_pro',
      }),
    ];
    sessionStorage.setItem(
      PENDING_PLAN_UPGRADE_STORAGE_KEY,
      JSON.stringify({
        invoiceId: 'inv_upgrade',
        planCode: 'plan_pro',
        planName: 'Pro',
        amount: '12.50',
        currency: 'USD',
        effectivePeriod: '2026-08',
        effectiveFrom: '2026-08-01T00:00:00.000Z',
      }),
    );

    renderBilling();
    await screen.findByText(/Pay to upgrade to Pro/i);

    expect(screen.queryByRole('button', { name: 'Subscribe' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Card' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'USDC' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay with card' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay with USDC' })).toBeInTheDocument();
  });
});

describe('Billing — plan deep-link selection and scroll', () => {
  let scrollIntoViewMock: ReturnType<typeof vi.fn>;
  let originalScrollIntoView: typeof Element.prototype.scrollIntoView;
  let originalRaf: typeof window.requestAnimationFrame;
  let originalCancelRaf: typeof window.cancelAnimationFrame;

  beforeEach(() => {
    originalScrollIntoView = Element.prototype.scrollIntoView;
    scrollIntoViewMock = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoViewMock;

    originalRaf = window.requestAnimationFrame;
    originalCancelRaf = window.cancelAnimationFrame;
    // Run the chooser scroll effect synchronously once plans paint.
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = vi.fn() as typeof window.cancelAnimationFrame;
  });

  afterEach(() => {
    Element.prototype.scrollIntoView = originalScrollIntoView;
    window.requestAnimationFrame = originalRaf;
    window.cancelAnimationFrame = originalCancelRaf;
  });

  function findPlanCard(planName: string) {
    const cards = screen.getAllByRole('listitem');
    const card = cards.find((el) => el.textContent?.includes(planName));
    expect(card).toBeTruthy();
    return card!;
  }

  it('selects and scrolls to ?plan=plan_pro#choose-a-plan without auto-assigning', async () => {
    currentInvoices = [makePaidInvoice('inv_1')];
    renderBilling('/dashboard/billing?plan=plan_pro#choose-a-plan');

    // Plans load → Pro is the deep-link selection (not current Starter).
    await screen.findByRole('button', { name: 'Upgrade to Pro' });

    await waitFor(() => {
      expect(findPlanCard('Pro').className).toMatch(/ring-brand-accent/);
    });

    await waitFor(() => expect(scrollIntoViewMock).toHaveBeenCalled());
    expect(scrollIntoViewMock).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: 'smooth', block: 'start' }),
    );

    // Deep-link only highlights; assign waits for an explicit click.
    expect(assignBillingPlanAuth).not.toHaveBeenCalled();
  });

  it('after Stripe ?success=1 cleanup, keeps plan query and deep-link selection', async () => {
    currentInvoices = [makePayableInvoice('inv_1')];
    renderBilling('/dashboard/billing?success=1&plan=plan_pro#choose-a-plan');

    expect(screen.getByText('Payment processing')).toBeInTheDocument();

    // success/canceled markers are stripped; plan deep-link query must remain.
    await waitFor(() => {
      expect(screen.getByTestId('location-search')).toHaveTextContent('plan=plan_pro');
      expect(screen.getByTestId('location-search')).not.toHaveTextContent('success=');
      expect(screen.getByTestId('location-hash')).toHaveTextContent('#choose-a-plan');
    });

    // Selection still targets Pro after marker cleanup (driven by ?plan=, not hash alone).
    await screen.findByRole('button', { name: 'Upgrade to Pro' });
    await waitFor(() => {
      expect(findPlanCard('Pro').className).toMatch(/ring-brand-accent/);
    });
    expect(assignBillingPlanAuth).not.toHaveBeenCalled();
  });

  it('ignores an unknown plan query and falls back to the current plan without mutation', async () => {
    currentInvoices = [makePaidInvoice('inv_1')];
    renderBilling('/dashboard/billing?plan=not_a_real_plan#choose-a-plan');

    expect(await screen.findByRole('button', { name: 'Current plan' })).toBeDisabled();
    // Current (Starter) is selected; Pro is not highlighted as the deep-link target.
    expect(findPlanCard('Starter').className).toMatch(/ring-green/);
    expect(findPlanCard('Pro').className).not.toMatch(/ring-brand-accent/);
    expect(assignBillingPlanAuth).not.toHaveBeenCalled();
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it('ignores enterprise plan query (contact-sales) without auto mutation', async () => {
    currentInvoices = [makePaidInvoice('inv_1')];
    vi.mocked(getBillingPlansAuth).mockResolvedValue({
      currentPlanId: 'plan_starter',
      plans: [
        ...makePlans().plans,
        {
          id: 'enterprise',
          name: 'Enterprise',
          description: 'Enterprise plan',
          basePrice: 'custom',
          currency: 'USD',
          billingPeriod: 'Monthly',
          features: [],
        },
      ],
    });

    renderBilling('/dashboard/billing?plan=enterprise#choose-a-plan');

    expect(await screen.findByRole('button', { name: 'Current plan' })).toBeDisabled();
    expect(findPlanCard('Starter').className).toMatch(/ring-green/);
    // Enterprise stays contact-sales and is not treated as a self-service deep-link target.
    const enterpriseCard = findPlanCard('Enterprise');
    expect(enterpriseCard.querySelector('button')?.textContent).toMatch(/Contact sales/i);
    expect(assignBillingPlanAuth).not.toHaveBeenCalled();
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });
});

describe('Billing — plan-change catalog guard (contact-sales plans)', () => {
  function makePlan(id: string, name: string, basePrice: string | null): BillingPlan {
    return {
      id,
      name,
      description: `${name} plan`,
      basePrice: basePrice as unknown as string,
      currency: 'USD',
      billingPeriod: 'Monthly',
      features: [],
    };
  }

  async function expectContactSalesBlocked(planName: string) {
    const cards = await screen.findAllByRole('listitem');
    const card = cards.find((el) => el.textContent?.includes(planName));
    expect(card).toBeTruthy();
    const contactBtn = card!.querySelector('button');
    expect(contactBtn).toBeTruthy();
    expect(contactBtn).toBeDisabled();
    expect(contactBtn!.textContent).toMatch(/Contact sales/i);
    fireEvent.click(contactBtn!);
    expect(vi.mocked(assignBillingPlanAuth)).not.toHaveBeenCalled();
  }

  it('keeps the Enterprise id contact-sales even with a numeric base price, while sibling plans stay self-service', async () => {
    currentInvoices = [makePaidInvoice('inv_1')];
    vi.mocked(getBillingPlansAuth).mockResolvedValue({
      currentPlanId: 'plan_starter',
      plans: [
        makePlan('plan_starter', 'Starter', '0.00'),
        makePlan('plan_pro', 'Pro', '49.00'),
        makePlan('enterprise', 'Enterprise', '1200.00'),
      ],
    });
    vi.mocked(assignBillingPlanAuth).mockResolvedValue({
      planCode: 'plan_pro',
      planName: 'Pro',
      effectivePeriod: '2026-08',
      effectiveFrom: '2026-08-01T00:00:00.000Z',
      outcome: 'payment_required',
      changeId: 'chg_1',
      invoiceId: 'inv_up',
      amount: '20.00',
      currency: 'USD',
      kind: 'upgrade',
    });

    renderBilling();

    await expectContactSalesBlocked('Enterprise');

    fireEvent.click(await screen.findByRole('button', { name: 'Upgrade to Pro' }));
    await waitFor(() =>
      expect(assignBillingPlanAuth).toHaveBeenCalledWith(expect.any(Function), 'plan_pro'),
    );
  });

  it('treats any casing of a "custom" base price as contact-sales', async () => {
    currentInvoices = [makePaidInvoice('inv_1')];
    vi.mocked(getBillingPlansAuth).mockResolvedValue({
      currentPlanId: 'plan_starter',
      plans: [
        makePlan('plan_starter', 'Starter', '0.00'),
        makePlan('plan_custom_lower', 'Custom Lower', 'custom'),
        makePlan('plan_custom_title', 'Custom Title', 'Custom'),
        makePlan('plan_custom_upper', 'Custom Upper', 'CUSTOM'),
      ],
    });

    renderBilling();

    await expectContactSalesBlocked('Custom Lower');
    await expectContactSalesBlocked('Custom Title');
    await expectContactSalesBlocked('Custom Upper');
  });

  it('treats a null base price as contact-sales', async () => {
    currentInvoices = [makePaidInvoice('inv_1')];
    vi.mocked(getBillingPlansAuth).mockResolvedValue({
      currentPlanId: 'plan_starter',
      plans: [
        makePlan('plan_starter', 'Starter', '0.00'),
        makePlan('plan_null_price', 'Custom (null base)', null),
      ],
    });

    renderBilling();

    await expectContactSalesBlocked('Custom (null base)');
  });

  it('treats empty and blank base prices as contact-sales', async () => {
    currentInvoices = [makePaidInvoice('inv_1')];
    vi.mocked(getBillingPlansAuth).mockResolvedValue({
      currentPlanId: 'plan_starter',
      plans: [
        makePlan('plan_starter', 'Starter', '0.00'),
        makePlan('plan_empty_price', 'Custom (empty base)', ''),
        makePlan('plan_blank_price', 'Custom (blank base)', '   '),
      ],
    });

    renderBilling();

    await expectContactSalesBlocked('Custom (empty base)');
    await expectContactSalesBlocked('Custom (blank base)');
  });
});
