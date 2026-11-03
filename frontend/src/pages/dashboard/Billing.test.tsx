import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useAppSession } from '@/components/AppSessionProvider';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import BillingPage from './Billing';
import {
  assignBillingPlanAuth,
  cancelBillingPlanAuth,
  cancelBillingPlanUpgradeAuth,
  cancelUsdcQuoteAuth,
  createBillingCheckoutSessionAuth,
  getBillingPlansAuth,
  getBillingSummaryAuth,
  getInvoicePaymentStatusAuth,
  listBillingInvoicesAuth,
  type BillingCheckoutResponse,
  type BillingInvoice,
  type BillingInvoicesResponse,
  type BillingPlan,
  type InvoicePaymentStatus,
} from '@/lib/api';
import {
  apiError,
  invoicesResponse,
  makeInvoice,
  makeInvoicePaymentStatus,
  makePaidInvoice,
  makePayableInvoice,
  makePlans,
  makeSummary,
} from '@/test/billing-helpers';

// Mirrors the bounded payment-confirmation polling contract implemented in Billing.tsx.
const PENDING_INVOICE_STORAGE_KEY = 'sofa-one.billing.pendingInvoiceId';
const POLL_INTERVAL_MS = 1500;
const MAX_POLL_ATTEMPTS = 6;

function storePendingInvoice(invoiceId: string, sessionId = 'session-1', userId = 'user-1') {
  sessionStorage.setItem(
    PENDING_INVOICE_STORAGE_KEY,
    JSON.stringify({ invoiceId, sessionId, userId }),
  );
}

function expectPendingInvoice(invoiceId: string) {
  expect(JSON.parse(sessionStorage.getItem(PENDING_INVOICE_STORAGE_KEY) ?? 'null')).toEqual({
    invoiceId,
    sessionId: 'session-1',
    userId: 'user-1',
  });
}

vi.mock('@/components/AppSessionProvider', () => ({ useAppSession: vi.fn() }));

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
    cancelBillingPlanAuth: vi.fn(),
    cancelBillingPlanUpgradeAuth: vi.fn(),
    cancelUsdcQuoteAuth: vi.fn(),
    getInvoicePaymentStatusAuth: vi.fn(),
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

function mockAppSession() {
  vi.mocked(useAppSession).mockReturnValue({
    session: {
      sessionId: 'session-1',
      userId: 'user-1',
      email: 'test@example.com',
      mfaVerified: true,
      expiresAt: '2099-01-01T00:00:00.000Z',
      csrfToken: 'csrf-token',
    },
    loading: false,
    error: null,
    refresh: vi.fn(),
    exchange: vi.fn(),
    signOut: vi.fn(),
    signOutAll: vi.fn(),
  });
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
  mockAppSession();
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
  vi.mocked(cancelBillingPlanAuth).mockResolvedValue({
    outcome: 'canceled',
    planCode: 'plan_pro',
    planName: 'Pro',
    effectivePeriod: '2026-08',
  });
  vi.mocked(cancelBillingPlanUpgradeAuth).mockResolvedValue({
    outcome: 'canceled',
    planCode: 'plan_starter',
    planName: 'Starter',
    effectivePeriod: '2026-08',
  });
  vi.mocked(cancelUsdcQuoteAuth).mockReset();
  vi.mocked(cancelUsdcQuoteAuth).mockResolvedValue({
    invoiceId: 'inv_1',
    paymentAttemptId: 'att_pending',
    status: 'cancelled',
    cancelledAt: '2026-08-01T12:00:00.000Z',
    cancelReason: 'user_requested',
  });
  vi.mocked(getInvoicePaymentStatusAuth).mockImplementation(async (invoiceId) => {
    const invoice = currentInvoices.find((item) => item.id === invoiceId);
    return makeInvoicePaymentStatus({
      invoiceId,
      invoiceStatus: invoice?.status ?? 'finalized',
      paid: invoice?.status === 'paid',
      paidAt: invoice?.paidAt ?? null,
    });
  });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

it('does not reload billing collections when introspection replaces the same session snapshot', async () => {
  const view = renderBilling();
  await waitFor(() => expect(getBillingPlansAuth).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(listBillingInvoicesAuth).toHaveBeenCalledTimes(1));
  const context = vi.mocked(useAppSession).mock.results[0].value;
  vi.mocked(useAppSession).mockReturnValue({
    ...context,
    session: { ...context.session, csrfToken: 'rechecked-csrf', expiresAt: '2099-02-01T00:00:00.000Z' },
  });
  await act(async () => {
    view.rerender(<MemoryRouter initialEntries={['/dashboard/billing']}><BillingPage /><LocationProbe /></MemoryRouter>);
  });
  expect(getBillingPlansAuth).toHaveBeenCalledTimes(1);
  expect(getBillingSummaryAuth).toHaveBeenCalledTimes(1);
  expect(listBillingInvoicesAuth).toHaveBeenCalledTimes(1);
});

describe('Billing — Stripe return markers and query cleanup', () => {
  it('shows the processing notice and strips the success param after ?success=1', async () => {
    vi.useFakeTimers();
    currentInvoices = [makePayableInvoice('inv_1')];
    renderBilling('/dashboard/billing?success=1');

    // The return-marker effect runs synchronously in render's act.
    expect(screen.getByText('Payment processing')).toBeInTheDocument();

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

    // No polling was started: nothing fires even well after the marker.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(vi.mocked(listBillingInvoicesAuth).mock.calls.length).toBe(2);
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
    // Only the initial load — the canceled-triggered refresh must not run.
    expect(vi.mocked(listBillingInvoicesAuth).mock.calls.length).toBe(1);
  });
});

describe('Billing — bounded payment-confirmation polling', () => {
  beforeEach(() => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  });

  it('confirms only the tracked invoice and stops checking once it is paid', async () => {
    vi.useFakeTimers();
    storePendingInvoice('inv_tracked');
    currentInvoices = [makePayableInvoice('inv_tracked'), makePayableInvoice('inv_other')];
    renderBilling('/dashboard/billing?success=1');
    await flushTimers();
    expect(screen.getByText('Payment processing')).toBeInTheDocument();

    currentInvoices = [makePaidInvoice('inv_tracked'), makePayableInvoice('inv_other')];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });

    expect(screen.getByText('Payment confirmed')).toBeInTheDocument();
    expect(sessionStorage.getItem(PENDING_INVOICE_STORAGE_KEY)).toBeNull();
    const settledCalls = vi.mocked(getInvoicePaymentStatusAuth).mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(getInvoicePaymentStatusAuth).toHaveBeenCalledTimes(settledCalls);
  });

  it('finds settlement for a tracked invoice outside the paginated list', async () => {
    vi.useFakeTimers();
    storePendingInvoice('inv_off_page');
    currentInvoices = [makePayableInvoice('inv_other')];
    vi.mocked(getInvoicePaymentStatusAuth).mockImplementation(async (invoiceId) =>
      makeInvoicePaymentStatus({ invoiceId, paid: invoiceId === 'inv_off_page' }),
    );
    renderBilling('/dashboard/billing?success=1');
    await flushTimers();

    expect(screen.getByText('Payment confirmed')).toBeInTheDocument();
    expect(getInvoicePaymentStatusAuth).toHaveBeenCalledWith('inv_off_page', expect.any(AbortSignal));
    expect(sessionStorage.getItem(PENDING_INVOICE_STORAGE_KEY)).toBeNull();
  });

  it('preserves an unpaid invoice after timeout and confirms delayed settlement on explicit retry', async () => {
    vi.useFakeTimers();
    storePendingInvoice('inv_1');
    currentInvoices = [makePayableInvoice('inv_1')];
    renderBilling('/dashboard/billing?success=1');
    await flushTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20 * POLL_INTERVAL_MS);
    });

    expect(screen.queryByText('Payment processing')).not.toBeInTheDocument();
    expect(screen.queryByText('Payment confirmed')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check payment status' })).toBeEnabled();
    expectPendingInvoice('inv_1');
    const pausedCalls = vi.mocked(getInvoicePaymentStatusAuth).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(getInvoicePaymentStatusAuth).toHaveBeenCalledTimes(pausedCalls);

    currentInvoices = [makePaidInvoice('inv_1')];
    fireEvent.click(screen.getByRole('button', { name: 'Check payment status' }));
    await flushTimers();

    expect(screen.getByText('Payment confirmed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check payment status' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Card' })).not.toBeInTheDocument();
    expect(sessionStorage.getItem(PENDING_INVOICE_STORAGE_KEY)).toBeNull();
  });

  it.each(['focus', 'visibilitychange'])('recovers delayed settlement on %s after automatic checks pause', async (event) => {
    vi.useFakeTimers();
    storePendingInvoice('inv_off_page');
    currentInvoices = [];
    renderBilling('/dashboard/billing?success=1');
    await flushTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20 * POLL_INTERVAL_MS);
    });
    expect(screen.getByRole('button', { name: 'Check payment status' })).toBeEnabled();
    expect(getInvoicePaymentStatusAuth).toHaveBeenCalledTimes(MAX_POLL_ATTEMPTS);

    vi.mocked(getInvoicePaymentStatusAuth).mockResolvedValue(
      makeInvoicePaymentStatus({ invoiceId: 'inv_off_page', paid: true }),
    );
    await act(async () => {
      (event === 'focus' ? window : document).dispatchEvent(new Event(event));
    });
    await flushTimers();

    expect(screen.getByText('Payment confirmed')).toBeInTheDocument();
    expect(sessionStorage.getItem(PENDING_INVOICE_STORAGE_KEY)).toBeNull();
  });

  it('coalesces focus/visibility recovery and never restarts aggressive polling after timeout', async () => {
    vi.useFakeTimers();
    storePendingInvoice('inv_1');
    currentInvoices = [];
    vi.mocked(getInvoicePaymentStatusAuth).mockRejectedValue(apiError(500));
    renderBilling('/dashboard/billing?success=1');
    await flushTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20 * POLL_INTERVAL_MS);
    });
    expect(getInvoicePaymentStatusAuth).toHaveBeenCalledTimes(MAX_POLL_ATTEMPTS);
    expect(screen.getByRole('button', { name: 'Check payment status' })).toBeEnabled();

    vi.mocked(getInvoicePaymentStatusAuth).mockResolvedValue(makeInvoicePaymentStatus());
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await flushTimers();
    expect(getInvoicePaymentStatusAuth).toHaveBeenCalledTimes(MAX_POLL_ATTEMPTS + 1);
    expect(screen.queryByText('Payment confirmed')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check payment status' })).toBeEnabled();
    expectPendingInvoice('inv_1');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(getInvoicePaymentStatusAuth).toHaveBeenCalledTimes(MAX_POLL_ATTEMPTS + 1);
  });

  it('keeps explicit recovery single-flight and ignores hidden-tab refreshes', async () => {
    vi.useFakeTimers();
    storePendingInvoice('inv_1');
    currentInvoices = [];
    renderBilling('/dashboard/billing?success=1');
    await flushTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20 * POLL_INTERVAL_MS);
    });
    const pausedCalls = vi.mocked(getInvoicePaymentStatusAuth).mock.calls.length;
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(getInvoicePaymentStatusAuth).toHaveBeenCalledTimes(pausedCalls);

    const pending = deferred<InvoicePaymentStatus>();
    vi.mocked(getInvoicePaymentStatusAuth).mockReturnValue(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Check payment status' }));
    expect(screen.getByRole('button', { name: 'Checking payment status…' })).toBeDisabled();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(getInvoicePaymentStatusAuth).toHaveBeenCalledTimes(pausedCalls + 1);
    await act(async () => {
      pending.resolve(makeInvoicePaymentStatus({ paid: true }));
    });
    expect(screen.getByText('Payment confirmed')).toBeInTheDocument();
  });

  it.each(['accepted', 'confirming'])('does not confirm %s/unpaid evidence or a contradictory paid list row', async (status) => {
    vi.useFakeTimers();
    storePendingInvoice('inv_1');
    currentInvoices = [makePaidInvoice('inv_1')];
    vi.mocked(getInvoicePaymentStatusAuth).mockResolvedValue(makeInvoicePaymentStatus({
      paid: false,
      paidAt: '2026-08-01T12:00:00.000Z',
      activeAttempt: {
        paymentAttemptId: 'att_accepted',
        method: 'usdc',
        status,
        chainId: 8453,
        quoteExpiresAt: null,
        createdAt: '2026-08-01T12:00:00.000Z',
        walletPaymentReserved: true,
        reviewReason: null,
      },
    }));
    renderBilling('/dashboard/billing?success=1');
    await flushTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20 * POLL_INTERVAL_MS);
    });

    expect(screen.queryByText('Payment confirmed')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check payment status' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Check payment status' }));
    await flushTimers();
    expect(screen.queryByText('Payment confirmed')).not.toBeInTheDocument();
    expectPendingInvoice('inv_1');
  });

  it('does not infer settlement from an unrelated paid invoice when checkout identity is missing', async () => {
    vi.useFakeTimers();
    currentInvoices = [makePaidInvoice('inv_other')];
    renderBilling('/dashboard/billing?success=1');
    await flushTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20 * POLL_INTERVAL_MS);
    });
    expect(screen.queryByText('Payment confirmed')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check payment status' })).toBeEnabled();
  });

  it('ignores an aborted initial list response after settlement refreshes the invoice', async () => {
    vi.useFakeTimers();
    storePendingInvoice('inv_1');
    currentInvoices = [makePaidInvoice('inv_1')];
    const stale = deferred<BillingInvoicesResponse>();
    vi.mocked(listBillingInvoicesAuth).mockImplementationOnce(() => stale.promise);
    renderBilling('/dashboard/billing?success=1');
    await flushTimers();
    expect(screen.getByText('Payment confirmed')).toBeInTheDocument();
    await act(async () => {
      stale.resolve(invoicesResponse([makePayableInvoice('inv_1')]));
    });
    expect(screen.getByText('Payment confirmed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Card' })).not.toBeInTheDocument();
  });

  it('aborts in-flight status/list reads and removes recovery listeners on unmount', async () => {
    vi.useFakeTimers();
    storePendingInvoice('inv_1');
    const status = deferred<InvoicePaymentStatus>();
    const list = deferred<BillingInvoicesResponse>();
    vi.mocked(getInvoicePaymentStatusAuth).mockReturnValue(status.promise);
    vi.mocked(listBillingInvoicesAuth).mockReturnValue(list.promise);
    const view = renderBilling('/dashboard/billing?success=1');
    await flushTimers();
    const statusSignal = vi.mocked(getInvoicePaymentStatusAuth).mock.calls[0][1];
    const listSignal = vi.mocked(listBillingInvoicesAuth).mock.calls[0][1];
    view.unmount();
    expect(statusSignal?.aborted).toBe(true);
    expect(listSignal?.aborted).toBe(true);
    const statusCalls = vi.mocked(getInvoicePaymentStatusAuth).mock.calls.length;
    await act(async () => {
      status.resolve(makeInvoicePaymentStatus({ paid: true }));
      list.resolve(invoicesResponse([makePaidInvoice('inv_1')]));
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(getInvoicePaymentStatusAuth).toHaveBeenCalledTimes(statusCalls);
  });

  it('removes paused recovery listeners on unmount without forgetting the pending invoice', async () => {
    vi.useFakeTimers();
    storePendingInvoice('inv_1');
    currentInvoices = [];
    const view = renderBilling('/dashboard/billing?success=1');
    await flushTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20 * POLL_INTERVAL_MS);
    });
    view.unmount();
    const statusCalls = vi.mocked(getInvoicePaymentStatusAuth).mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(getInvoicePaymentStatusAuth).toHaveBeenCalledTimes(statusCalls);
    expectPendingInvoice('inv_1');
  });

  it.each(['replacement', 'logout'])('invalidates session recovery on %s even when an aborted request resolves paid', async (transition) => {
    vi.useFakeTimers();
    storePendingInvoice('inv_1');
    const stale = deferred<InvoicePaymentStatus>();
    vi.mocked(getInvoicePaymentStatusAuth).mockReturnValue(stale.promise);
    const view = renderBilling('/dashboard/billing?success=1');
    await flushTimers();
    const oldSignal = vi.mocked(getInvoicePaymentStatusAuth).mock.calls[0][1];
    const context = vi.mocked(useAppSession).mock.results[0].value;
    vi.mocked(useAppSession).mockReturnValue({
      ...context,
      session: transition === 'logout' ? null : { ...context.session, sessionId: 'session-2' },
    });
    await act(async () => {
      view.rerender(<MemoryRouter><BillingPage /><LocationProbe /></MemoryRouter>);
    });
    expect(oldSignal?.aborted).toBe(true);
    expect(sessionStorage.getItem(PENDING_INVOICE_STORAGE_KEY)).toBeNull();
    await act(async () => {
      stale.resolve(makeInvoicePaymentStatus({ paid: true }));
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(screen.queryByText('Payment confirmed')).not.toBeInTheDocument();
    expect(screen.queryByText('Payment processing')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check payment status' })).not.toBeInTheDocument();
  });
  it.each([
    { label: 'another session', sessionId: 'session-2', userId: 'user-1' },
    { label: 'another user', sessionId: 'session-2', userId: 'user-2' },
    { label: 'a mismatched user binding', sessionId: 'session-1', userId: 'user-2' },
  ])('does not revive a prior checkout after remounting as $label', async ({ sessionId, userId }) => {
    vi.useFakeTimers();
    storePendingInvoice('inv_previous');
    currentInvoices = [];
    const previousView = renderBilling('/dashboard/billing?success=1');
    await flushTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20 * POLL_INTERVAL_MS);
    });
    expectPendingInvoice('inv_previous');
    previousView.unmount();

    const context = vi.mocked(useAppSession).mock.results[0].value;
    vi.mocked(useAppSession).mockReturnValue({
      ...context,
      session: { ...context.session, sessionId, userId },
    });
    const previousCalls = vi.mocked(getInvoicePaymentStatusAuth).mock.calls.length;
    vi.mocked(getInvoicePaymentStatusAuth).mockResolvedValue(
      makeInvoicePaymentStatus({ invoiceId: 'inv_previous', paid: true }),
    );
    renderBilling('/dashboard/billing?success=1');
    await flushTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20 * POLL_INTERVAL_MS);
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(getInvoicePaymentStatusAuth).toHaveBeenCalledTimes(previousCalls);
    expect(sessionStorage.getItem(PENDING_INVOICE_STORAGE_KEY)).toBeNull();
    expect(screen.queryByText('Payment confirmed')).not.toBeInTheDocument();
  });

  it('retains checkout identity across a same-session remount', async () => {
    vi.useFakeTimers();
    storePendingInvoice('inv_1');
    currentInvoices = [];
    const previousView = renderBilling('/dashboard/billing?success=1');
    await flushTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20 * POLL_INTERVAL_MS);
    });
    previousView.unmount();
    expectPendingInvoice('inv_1');
    vi.mocked(getInvoicePaymentStatusAuth).mockResolvedValue(
      makeInvoicePaymentStatus({ invoiceId: 'inv_1', paid: true }),
    );
    renderBilling('/dashboard/billing?success=1');
    await flushTimers();
    expect(screen.getByText('Payment confirmed')).toBeInTheDocument();
    expect(sessionStorage.getItem(PENDING_INVOICE_STORAGE_KEY)).toBeNull();
  });

  it.each([
    'inv_unscoped',
    JSON.stringify('inv_unscoped'),
    JSON.stringify({ invoiceId: 'inv_unscoped' }),
    '{invalid',
    'null',
  ])('rejects unbound or malformed checkout storage: %s', async (stored) => {
    vi.useFakeTimers();
    sessionStorage.setItem(PENDING_INVOICE_STORAGE_KEY, stored);
    currentInvoices = [makePaidInvoice('inv_unrelated')];
    renderBilling('/dashboard/billing?success=1');
    await flushTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20 * POLL_INTERVAL_MS);
    });
    expect(getInvoicePaymentStatusAuth).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(PENDING_INVOICE_STORAGE_KEY)).toBeNull();
    expect(screen.queryByText('Payment confirmed')).not.toBeInTheDocument();
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

describe('Billing — estimated cost overage note', () => {
  it('renders the formatted outbound free allowance and never shows outbound_volume', async () => {
    vi.mocked(getBillingSummaryAuth).mockResolvedValue({
      ...makeSummary(),
      outboundFreeAllowance: '250000',
      overageRate: '0.0100%',
      overageUnit: 'outbound_volume',
      currency: 'USD',
    });

    renderBilling();

    const note = await screen.findByText(/Overage rate:/i);
    expect(note).toHaveTextContent(
      'Overage rate: 0.0100% per 250000 outbound volume beyond the free allowance.',
    );
    expect(note).not.toHaveTextContent('USD');
    expect(note).not.toHaveTextContent('outbound_volume');
  });
});

describe('Billing — wallet usage provenance', () => {
  it('does not describe a finalized legacy instantaneous count as a monthly peak', async () => {
    vi.mocked(getBillingSummaryAuth).mockResolvedValue({
      ...makeSummary(),
      walletUsageMetric: 'legacy_instantaneous',
      activeWallets: '3',
    });

    renderBilling();

    expect(await screen.findByText('Active wallets (instantaneous count)')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText(/point-in-time count; not a monthly peak/i)).toBeInTheDocument();
    expect(screen.queryByText('Monthly peak active wallets')).not.toBeInTheDocument();
    expect(screen.queryByText(/highest concurrent count this month/i)).not.toBeInTheDocument();
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
      expect(createBillingCheckoutSessionAuth).toHaveBeenCalledWith('inv_1'),
    );
    expectPendingInvoice('inv_1');
    expect(locationStub.href).toBe('https://checkout.stripe.example/start');
  });

  it('does not save or redirect a late checkout response from an unmounted session', async () => {
    currentInvoices = [makePayableInvoice('inv_1')];
    const pending = deferred<BillingCheckoutResponse>();
    vi.mocked(createBillingCheckoutSessionAuth).mockReturnValue(pending.promise);
    const view = renderBilling();
    fireEvent.click(await screen.findByRole('button', { name: 'Card' }));
    await waitFor(() => expect(createBillingCheckoutSessionAuth).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => {
      pending.resolve({
        invoiceId: 'inv_1',
        sessionId: 'cs_previous',
        checkoutUrl: 'https://checkout.stripe.example/previous',
      });
    });
    expect(sessionStorage.getItem(PENDING_INVOICE_STORAGE_KEY)).toBeNull();
    expect(locationStub.href).toBe('');
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

    // BILL-003: 409 surfaces the server conflict message (or active-payment copy) instead of a
    // generic "Could not start checkout" so the user knows why card was refused.
    expect(await screen.findByText(/Invoice is no longer payable/i)).toBeInTheDocument();
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
        'inv_plan',
      ),
    );
    expectPendingInvoice('inv_plan');
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
      expect(assignBillingPlanAuth).toHaveBeenCalledWith('plan_starter'),
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
      expect(assignBillingPlanAuth).toHaveBeenCalledWith('plan_pro'),
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
        'inv_upgrade',
      ),
    );
    expectPendingInvoice('inv_upgrade');
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

    fireEvent.click(await screen.findByRole('button', { name: 'Pay with USDC' }));
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

  it('renders cancel control for a paid scheduled downgrade and cancels after confirm', async () => {
    currentInvoices = [makePaidInvoice('inv_1')];
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    // Initial load has a paid-plan schedule; later refreshes clear it.
    vi.mocked(getBillingPlansAuth)
      .mockResolvedValueOnce({
        currentPlanId: 'plan_pro',
        scheduledPlan: {
          planCode: 'plan_starter',
          planName: 'Starter',
          effectivePeriod: '2026-09',
        },
        plans: makePlans().plans,
      })
      .mockResolvedValue({
        currentPlanId: 'plan_pro',
        plans: makePlans().plans,
      });
    vi.mocked(cancelBillingPlanAuth).mockResolvedValue({
      outcome: 'canceled',
      planCode: 'plan_pro',
      planName: 'Pro',
      effectivePeriod: '2026-08',
    });

    renderBilling();

    const cancelBtn = await screen.findByRole('button', {
      name: 'Cancel scheduled change to Starter',
    });
    expect(screen.getByText('Scheduled downgrade')).toBeInTheDocument();
    expect(screen.getByText(/Starter begins/i)).toBeInTheDocument();
    // Scheduled target stays non-actionable — cancel is only on the status card.
    expect(screen.getByRole('button', { name: 'Already scheduled' })).toBeDisabled();

    fireEvent.click(cancelBtn);

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() =>
      expect(cancelBillingPlanAuth).toHaveBeenCalledWith(),
    );
    expect(screen.getByText('Scheduled change canceled')).toBeInTheDocument();
    expect(screen.getByText(/You will stay on Pro/i)).toBeInTheDocument();
    expect(assignBillingPlanAuth).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it('does not call cancel when the user dismisses the confirmation', async () => {
    currentInvoices = [makePaidInvoice('inv_1')];
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    vi.mocked(getBillingPlansAuth).mockResolvedValue({
      currentPlanId: 'plan_pro',
      scheduledPlan: {
        planCode: 'plan_starter',
        planName: 'Starter',
        effectivePeriod: '2026-09',
      },
      plans: makePlans().plans,
    });

    renderBilling();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Cancel scheduled change to Starter' }),
    );

    expect(confirmSpy).toHaveBeenCalled();
    expect(cancelBillingPlanAuth).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('shows the backend error when canceling a scheduled change fails', async () => {
    currentInvoices = [makePaidInvoice('inv_1')];
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(getBillingPlansAuth).mockResolvedValue({
      currentPlanId: 'plan_pro',
      scheduledPlan: {
        planCode: 'plan_starter',
        planName: 'Starter',
        effectivePeriod: '2026-09',
      },
      plans: makePlans().plans,
    });
    vi.mocked(cancelBillingPlanAuth).mockRejectedValue(
      new Error('Could not cancel scheduled plan change.'),
    );

    renderBilling();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Cancel scheduled change to Starter' }),
    );

    expect(await screen.findByText('Could not cancel scheduled plan change.')).toBeInTheDocument();
    expect(screen.getByText('Could not cancel scheduled change')).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('cancels a pending upgrade after confirm and clears session state', async () => {
    currentInvoices = [
      makeInvoice({
        id: 'inv_upgrade',
        status: 'finalized',
        amount: '12.50',
        currency: 'USD',
      }),
    ];
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
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
    vi.mocked(cancelBillingPlanUpgradeAuth).mockResolvedValue({
      outcome: 'canceled',
      planCode: 'plan_starter',
      planName: 'Starter',
      effectivePeriod: '2026-08',
    });

    renderBilling();

    await screen.findByText(/Pay to upgrade to Pro/i);
    fireEvent.click(screen.getByRole('button', { name: 'Pay with USDC' }));
    expect(screen.getByTestId('usdc-panel-invoice')).toHaveTextContent('inv_upgrade');

    fireEvent.click(
      screen.getByRole('button', { name: 'Cancel pending upgrade to Pro' }),
    );

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() =>
      expect(cancelBillingPlanUpgradeAuth).toHaveBeenCalledWith(),
    );
    expect(screen.getByText('Upgrade canceled')).toBeInTheDocument();
    expect(screen.getByText(/You will stay on Starter/i)).toBeInTheDocument();
    expect(sessionStorage.getItem(PENDING_PLAN_UPGRADE_STORAGE_KEY)).toBeNull();
    expect(screen.queryByText(/Pay to upgrade to Pro/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('usdc-panel')).not.toBeInTheDocument();
    // Scheduled-downgrade cancel control must not appear for upgrade-only state.
    expect(screen.queryByText('Scheduled downgrade')).not.toBeInTheDocument();
    expect(cancelBillingPlanAuth).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it('does not cancel a pending upgrade when confirmation is dismissed', async () => {
    currentInvoices = [
      makeInvoice({
        id: 'inv_upgrade',
        status: 'finalized',
        amount: '12.50',
        currency: 'USD',
      }),
    ];
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
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

    fireEvent.click(
      await screen.findByRole('button', { name: 'Cancel pending upgrade to Pro' }),
    );

    expect(confirmSpy).toHaveBeenCalled();
    expect(cancelBillingPlanUpgradeAuth).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(PENDING_PLAN_UPGRADE_STORAGE_KEY)).toBeTruthy();
    expect(screen.getByText(/Pay to upgrade to Pro/i)).toBeInTheDocument();

    confirmSpy.mockRestore();
  });

  it('shows a distinct no-op notice when upgrade cancel returns unchanged', async () => {
    currentInvoices = [
      makeInvoice({
        id: 'inv_upgrade',
        status: 'finalized',
        amount: '12.50',
        currency: 'USD',
      }),
    ];
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
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
    vi.mocked(cancelBillingPlanUpgradeAuth).mockResolvedValue({
      outcome: 'unchanged',
    });

    renderBilling();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Cancel pending upgrade to Pro' }),
    );

    expect(await screen.findByText('No pending upgrade')).toBeInTheDocument();
    expect(screen.getByText(/There was no pending upgrade to cancel/i)).toBeInTheDocument();
    // Unchanged does not clear local pending upgrade UI/session.
    expect(sessionStorage.getItem(PENDING_PLAN_UPGRADE_STORAGE_KEY)).toBeTruthy();
    expect(await screen.findByText(/Pay to upgrade to Pro/i)).toBeInTheDocument();

    confirmSpy.mockRestore();
  });

  it('keeps pending upgrade state and shows the backend error when cancel fails', async () => {
    currentInvoices = [
      makeInvoice({
        id: 'inv_upgrade',
        status: 'finalized',
        amount: '12.50',
        currency: 'USD',
      }),
    ];
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
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
    vi.mocked(cancelBillingPlanUpgradeAuth).mockRejectedValue(
      new Error('Could not cancel pending upgrade.'),
    );

    renderBilling();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Cancel pending upgrade to Pro' }),
    );

    expect(await screen.findByText('Could not cancel pending upgrade.')).toBeInTheDocument();
    expect(screen.getByText('Could not cancel upgrade')).toBeInTheDocument();
    expect(sessionStorage.getItem(PENDING_PLAN_UPGRADE_STORAGE_KEY)).toBeTruthy();
    expect(screen.getByText(/Pay to upgrade to Pro/i)).toBeInTheDocument();

    confirmSpy.mockRestore();
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

describe('Billing — read-only renewal status', () => {
  it('shows enabled renewal details, next charge date, and amount', async () => {
    vi.mocked(getBillingPlansAuth).mockResolvedValue({
      ...makePlans(),
      renewal: {
        status: 'enabled',
        subscriptionStatus: 'active',
        paymentMethod: 'card',
        nextChargeAt: '2026-10-01T00:00:00.000Z',
        amount: '49.00',
        currency: 'USD',
      },
    });
    renderBilling();

    const card = await screen.findByRole('region', { name: 'Automatic renewal' });
    expect(card).toHaveTextContent('On');
    expect(card).toHaveTextContent('Active');
    expect(card).toHaveTextContent('Card');
    expect(card).toHaveTextContent(/2026年10月1日|October 1, 2026/);
    expect(card).toHaveTextContent('USD 49.00');
  });

  it('shows pending without suggesting renewal is on or off', async () => {
    vi.mocked(getBillingPlansAuth).mockResolvedValue({
      ...makePlans(),
      renewal: {
        status: 'pending',
        subscriptionStatus: 'pending',
        paymentMethod: 'unknown',
        nextChargeAt: null,
        amount: null,
        currency: null,
      },
    });
    renderBilling();

    const card = await screen.findByRole('region', { name: 'Automatic renewal' });
    expect(card).toHaveTextContent('Pending');
    expect(card).toHaveTextContent('Not available');
    expect(card).not.toHaveTextContent('On');
    expect(card).not.toHaveTextContent('Off');
  });

  it('shows needs-attention without suggesting renewal is on or off', async () => {
    vi.mocked(getBillingPlansAuth).mockResolvedValue({
      ...makePlans(),
      renewal: {
        status: 'needs_attention',
        subscriptionStatus: 'past_due',
        paymentMethod: 'unknown',
        nextChargeAt: null,
        amount: null,
        currency: null,
      },
    });
    renderBilling();

    const card = await screen.findByRole('region', { name: 'Automatic renewal' });
    expect(card).toHaveTextContent('Needs attention');
    expect(card).toHaveTextContent('Past due');
    expect(card).toHaveTextContent('Not available');
    expect(card).not.toHaveTextContent('On');
    expect(card).not.toHaveTextContent('Off');
  });

  it('explains that a disabled free plan does not renew automatically', async () => {
    vi.mocked(getBillingPlansAuth).mockResolvedValue({
      ...makePlans(),
      currentPlanId: 'free',
      plans: [
        {
          id: 'free',
          name: 'Free',
          description: 'Free plan',
          basePrice: '0.00',
          currency: 'USD',
          billingPeriod: 'Monthly',
          features: [],
        },
      ],
      renewal: {
        status: 'disabled',
        subscriptionStatus: 'none',
        paymentMethod: 'none',
        nextChargeAt: null,
        amount: null,
        currency: null,
      },
    });
    renderBilling();

    const card = await screen.findByRole('region', { name: 'Automatic renewal' });
    expect(card).toHaveTextContent('Off');
    expect(card).toHaveTextContent('This plan does not renew automatically.');
    expect(card).toHaveTextContent('No subscription');
  });

  it('keeps missing renewal information neutral', async () => {
    vi.mocked(getBillingPlansAuth).mockResolvedValue({
      ...makePlans(),
      renewal: undefined,
    });
    renderBilling();

    const card = await screen.findByRole('region', { name: 'Automatic renewal' });
    expect(card).toHaveTextContent('Not available');
    expect(card).not.toHaveTextContent('On');
    expect(card).not.toHaveTextContent('Off');
    expect(card).not.toHaveTextContent('Next charge');
    expect(card).not.toHaveTextContent('Amount');
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
      expect(assignBillingPlanAuth).toHaveBeenCalledWith('plan_pro'),
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

describe('Billing — BILL-018 payment status recovery and BILL-003 card lock', () => {
  it('loads invoice-level payment status after invoices and surfaces needs_review without auto-opening USDC', async () => {
    currentInvoices = [makePayableInvoice('inv_1')];
    vi.mocked(getInvoicePaymentStatusAuth).mockResolvedValue(
      makeInvoicePaymentStatus({
        invoiceId: 'inv_1',
        hasUnresolvedReview: true,
        blockingReasons: ['duplicate_unallocated'],
        unresolvedReviewAttempts: [
          {
            paymentAttemptId: 'att_review',
            method: 'usdc',
            status: 'needs_review',
            reviewReason: 'duplicate_unallocated',
            createdAt: '2026-08-01T00:00:00.000Z',
            walletPaymentReserved: false,
            chainId: 84532,
            quoteExpiresAt: null,
          },
        ],
      }),
    );

    renderBilling();

    expect(await screen.findByText(/Payment needs review/i)).toBeInTheDocument();
    expect(screen.getByText(/already used on another invoice/i)).toBeInTheDocument();
    expect(getInvoicePaymentStatusAuth).toHaveBeenCalledWith(
      'inv_1',
      expect.anything(),
    );

    const cardBtn = screen.getByRole('button', { name: /Card unavailable/i });
    expect(cardBtn).toBeDisabled();
    expect(screen.queryByTestId('usdc-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Status' }));
    expect(screen.getByTestId('usdc-panel-invoice')).toHaveTextContent('inv_1');
  });

  it('disables card and shows continue entry while an active USDC quote is pending (BILL-003)', async () => {
    currentInvoices = [makePayableInvoice('inv_1')];
    vi.mocked(getInvoicePaymentStatusAuth).mockResolvedValue(
      makeInvoicePaymentStatus({
        invoiceId: 'inv_1',
        activeAttempt: {
          paymentAttemptId: 'att_pending',
          method: 'usdc',
          status: 'pending',
          reviewReason: null,
          createdAt: '2026-08-01T00:00:00.000Z',
          walletPaymentReserved: false,
          chainId: 84532,
          quoteExpiresAt: '2099-12-31T23:59:59.000Z',
        },
      }),
    );

    renderBilling();

    expect(
      await screen.findByText(/Unused USDC quote — continue, cancel, or wait for expiry/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/^USDC in progress$/i)).toBeInTheDocument();

    const cardBtn = screen.getByRole('button', { name: /Card unavailable/i });
    expect(cardBtn).toBeDisabled();
    fireEvent.click(cardBtn);
    expect(createBillingCheckoutSessionAuth).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByTestId('usdc-panel-invoice')).toHaveTextContent('inv_1');
  });

  it('offers Cancel quote for a clean pending USDC attempt and cancels after confirm', async () => {
    currentInvoices = [makePayableInvoice('inv_1')];
    vi.mocked(getInvoicePaymentStatusAuth)
      .mockResolvedValueOnce(
        makeInvoicePaymentStatus({
          invoiceId: 'inv_1',
          activeAttempt: {
            paymentAttemptId: 'att_pending',
            method: 'usdc',
            status: 'pending',
            reviewReason: null,
            createdAt: '2026-08-01T00:00:00.000Z',
            walletPaymentReserved: false,
            chainId: 84532,
            quoteExpiresAt: '2099-12-31T23:59:59.000Z',
          },
        }),
      )
      .mockResolvedValue(makeInvoicePaymentStatus({ invoiceId: 'inv_1' }));

    renderBilling();

    const cancelBtn = await screen.findByRole('button', {
      name: /Cancel unused USDC quote/i,
    });
    fireEvent.click(cancelBtn);

    await waitFor(() => expect(cancelUsdcQuoteAuth).toHaveBeenCalledTimes(1));
    expect(cancelUsdcQuoteAuth).toHaveBeenCalledWith(
      'inv_1',
      'att_pending',
    );
    expect(window.confirm).toHaveBeenCalled();
    expect(await screen.findByText(/USDC quote cancelled/i)).toBeInTheDocument();
  });

  it('does not cancel when confirmation is dismissed', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    currentInvoices = [makePayableInvoice('inv_1')];
    vi.mocked(getInvoicePaymentStatusAuth).mockResolvedValue(
      makeInvoicePaymentStatus({
        invoiceId: 'inv_1',
        activeAttempt: {
          paymentAttemptId: 'att_pending',
          method: 'usdc',
          status: 'pending',
          reviewReason: null,
          createdAt: '2026-08-01T00:00:00.000Z',
          walletPaymentReserved: false,
          chainId: 84532,
          quoteExpiresAt: '2099-12-31T23:59:59.000Z',
        },
      }),
    );

    renderBilling();
    fireEvent.click(
      await screen.findByRole('button', { name: /Cancel unused USDC quote/i }),
    );
    expect(cancelUsdcQuoteAuth).not.toHaveBeenCalled();
  });

  it('hides Cancel quote while confirming or reserved (no misleading cancel)', async () => {
    currentInvoices = [makePayableInvoice('inv_1')];
    vi.mocked(getInvoicePaymentStatusAuth).mockResolvedValue(
      makeInvoicePaymentStatus({
        invoiceId: 'inv_1',
        activeAttempt: {
          paymentAttemptId: 'att_confirming',
          method: 'usdc',
          status: 'confirming',
          reviewReason: null,
          createdAt: '2026-08-01T00:00:00.000Z',
          walletPaymentReserved: false,
          chainId: 84532,
          quoteExpiresAt: '2099-12-31T23:59:59.000Z',
        },
      }),
    );

    renderBilling();
    expect(
      await screen.findByText(/USDC confirming — do not cancel or switch to card/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/^USDC confirming$/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Cancel unused USDC quote/i }),
    ).not.toBeInTheDocument();
  });

  it('USDC_CANCEL_NOT_ALLOWED shows conflict notice and refreshes payment status', async () => {
    currentInvoices = [makePayableInvoice('inv_1')];
    vi.mocked(getInvoicePaymentStatusAuth).mockResolvedValue(
      makeInvoicePaymentStatus({
        invoiceId: 'inv_1',
        activeAttempt: {
          paymentAttemptId: 'att_pending',
          method: 'usdc',
          status: 'pending',
          reviewReason: null,
          createdAt: '2026-08-01T00:00:00.000Z',
          walletPaymentReserved: false,
          chainId: 84532,
          quoteExpiresAt: '2099-12-31T23:59:59.000Z',
        },
      }),
    );
    vi.mocked(cancelUsdcQuoteAuth).mockRejectedValue(
      apiError(409, { code: 'USDC_CANCEL_NOT_ALLOWED' }),
    );

    renderBilling();
    const statusCallsBefore = vi.mocked(getInvoicePaymentStatusAuth).mock.calls.length;
    fireEvent.click(
      await screen.findByRole('button', { name: /Cancel unused USDC quote/i }),
    );

    expect(await screen.findByText(/can no longer be cancelled/i)).toBeInTheDocument();
    // Never invent cancel success on 409.
    expect(screen.queryByText(/USDC quote cancelled/i)).not.toBeInTheDocument();
    await waitFor(() => expect(cancelUsdcQuoteAuth).toHaveBeenCalledTimes(1));
    // Conflict path refreshes invoice list payment status.
    await waitFor(() =>
      expect(vi.mocked(getInvoicePaymentStatusAuth).mock.calls.length).toBeGreaterThan(
        statusCallsBefore,
      ),
    );
  });
});
