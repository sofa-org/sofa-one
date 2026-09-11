import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UsdcPaymentPanel } from './UsdcPaymentPanel';
import { createUsdcClaimAuth, createUsdcQuoteAuth, type BillingInvoice } from '@/lib/api';
import { apiError, makePayableInvoice, makeQuote, VALID_TX_HASH } from '@/test/billing-helpers';

// Narrowly mock the API layer: keep ApiError/isApiError/hasApiErrorCode real so the
// panel's error-code contract (USDC_INVOICE_NOT_PAYABLE, etc.) is exercised against
// genuine ApiError instances. Only the network calls are stubbed.
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    createUsdcQuoteAuth: vi.fn(),
    createUsdcClaimAuth: vi.fn(),
  };
});

function renderPanel(
  over: Partial<{
    invoice: BillingInvoice;
    onChange: () => Promise<boolean> | boolean;
  }> = {},
) {
  const getToken = vi.fn().mockResolvedValue('test-token');
  const onChange = over.onChange ?? vi.fn().mockResolvedValue(true);
  const invoice = over.invoice ?? makePayableInvoice('inv_1');

  const view = render(
    <UsdcPaymentPanel invoice={invoice} getToken={getToken} onChange={onChange} />,
  );

  return { view, onChange, invoice };
}

/** Render the panel and wait until a quote has loaded and the claim form is usable. */
async function renderWithQuote() {
  vi.mocked(createUsdcQuoteAuth).mockResolvedValue(makeQuote());

  const ctx = renderPanel();

  // The amount/claim form only renders once a quote is present.
  const txInput = await screen.findByLabelText('Transaction hash');
  fireEvent.change(txInput, { target: { value: VALID_TX_HASH } });

  return ctx;
}

function submitClaim() {
  fireEvent.click(screen.getByRole('button', { name: /Claim payment/ }));
}

const claimButton = () => screen.queryByRole('button', { name: /Claim payment/ });

beforeEach(() => {
  vi.mocked(createUsdcQuoteAuth).mockReset();
  vi.mocked(createUsdcClaimAuth).mockReset();
});

describe('UsdcPaymentPanel — 409 USDC conflict classification', () => {
  it('USDC_INVOICE_NOT_PAYABLE shows truthful no-longer-payable messaging, refreshes the invoice, and clears the quote', async () => {
    const { onChange } = await renderWithQuote();
    expect(claimButton()).toBeInTheDocument();

    vi.mocked(createUsdcClaimAuth).mockRejectedValue(
      apiError(409, { code: 'USDC_INVOICE_NOT_PAYABLE' }),
    );

    submitClaim();

    // The panel refreshes the invoice server-side and reports success.
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText(/Invoice status refreshed\. This invoice is no longer payable/),
    ).toBeInTheDocument();

    // The stale quote is invalidated: the claim form/amount is gone.
    expect(claimButton()).not.toBeInTheDocument();
    // No generic conflict error is shown for this known code.
    expect(screen.queryByText(/A conflict occurred while processing/)).not.toBeInTheDocument();
  });

  it('USDC_INVOICE_NOT_PAYABLE does not claim settlement', async () => {
    await renderWithQuote();
    vi.mocked(createUsdcClaimAuth).mockRejectedValue(
      apiError(409, { code: 'USDC_INVOICE_NOT_PAYABLE' }),
    );

    submitClaim();

    // No settlement claim — only the no-longer-payable notice is shown.
    expect(await screen.findByText(/Invoice status refreshed/)).toBeInTheDocument();
    expect(screen.queryByText(/Payment received and settled/)).not.toBeInTheDocument();
  });

  it('USDC_PAYMENT_IN_PROGRESS shows a wait message without claiming settlement and preserves the quote', async () => {
    const { onChange } = await renderWithQuote();

    vi.mocked(createUsdcClaimAuth).mockRejectedValue(
      apiError(409, { code: 'USDC_PAYMENT_IN_PROGRESS' }),
    );

    submitClaim();

    expect(
      await screen.findByText(
        /A USDC payment is already in progress for this invoice\. Wait for it to complete/,
      ),
    ).toBeInTheDocument();

    // The current quote must be preserved so the user can retry after waiting.
    expect(claimButton()).toBeInTheDocument();
    // No invoice refresh and no settlement claim.
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByText(/Payment received and settled/)).not.toBeInTheDocument();
  });

  it('USDC_INVALID_ATTEMPT asks for a new quote and invalidates the stale quote', async () => {
    const { onChange } = await renderWithQuote();
    expect(claimButton()).toBeInTheDocument();

    vi.mocked(createUsdcClaimAuth).mockRejectedValue(
      apiError(409, { code: 'USDC_INVALID_ATTEMPT' }),
    );

    submitClaim();

    expect(
      await screen.findByText(
        /This payment attempt or quote is no longer valid\. Request a new quote to continue\./,
      ),
    ).toBeInTheDocument();

    // The stale quote is invalidated so the user must request a fresh one.
    expect(claimButton()).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('USDC_WALLET_NOT_ACTIVE shows the wallet precondition without settlement behavior and preserves the quote', async () => {
    const { onChange } = await renderWithQuote();

    vi.mocked(createUsdcClaimAuth).mockRejectedValue(
      apiError(409, { code: 'USDC_WALLET_NOT_ACTIVE' }),
    );

    submitClaim();

    expect(
      await screen.findByText(
        /Your wallet is not active yet\. Finish wallet setup and try again\./,
      ),
    ).toBeInTheDocument();

    // Wallet precondition is not a settlement path; the quote stays usable.
    expect(claimButton()).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByText(/Payment received and settled/)).not.toBeInTheDocument();
  });

  it('an unknown 409 falls back to a generic conflict message and does not clear a valid quote', async () => {
    const { onChange } = await renderWithQuote();
    expect(claimButton()).toBeInTheDocument();

    vi.mocked(createUsdcClaimAuth).mockRejectedValue(
      apiError(409, { code: 'SOME_UNKNOWN_CONFLICT' }),
    );

    submitClaim();

    expect(
      await screen.findByText(/A conflict occurred while processing the USDC payment\./),
    ).toBeInTheDocument();

    // Unknown code → the current (valid) quote is preserved for retry.
    expect(claimButton()).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
