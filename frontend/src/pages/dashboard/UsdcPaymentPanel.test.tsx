import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UsdcPaymentPanel } from './UsdcPaymentPanel';
import {
  createUsdcClaimAuth,
  createUsdcQuoteAuth,
  getUsdcPaymentStatusAuth,
  payUsdcFromWalletAuth,
  type BillingInvoice,
} from '@/lib/api';
import {
  apiError,
  makePayableInvoice,
  makeQuote,
  makeWalletPayResult,
  VALID_TX_HASH,
} from '@/test/billing-helpers';
import { requestStepUpToken } from './step-up';
import { getDashboardStepUpToken } from './step-up-session';

// Narrowly mock the API layer: keep ApiError/isApiError/hasApiErrorCode real so the
// panel's error-code contract is exercised against genuine ApiError instances.
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    createUsdcQuoteAuth: vi.fn(),
    createUsdcClaimAuth: vi.fn(),
    payUsdcFromWalletAuth: vi.fn(),
    getUsdcPaymentStatusAuth: vi.fn(),
  };
});

vi.mock('./step-up', () => ({
  requestStepUpToken: vi.fn(),
}));

vi.mock('./step-up-session', () => ({
  getDashboardStepUpToken: vi.fn(),
  storeDashboardStepUpProof: vi.fn(),
  clearDashboardStepUpProof: vi.fn(),
}));

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

  return { view, onChange, invoice, getToken };
}

/** Render the panel and wait until a quote has loaded and the claim form is usable. */
async function renderWithQuote() {
  vi.mocked(createUsdcQuoteAuth).mockResolvedValue(makeQuote());
  vi.mocked(getUsdcPaymentStatusAuth).mockResolvedValue(makeWalletPayResult());

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
const payFromWalletButton = () => screen.queryByRole('button', { name: /Pay from wallet/i });

beforeEach(() => {
  vi.mocked(createUsdcQuoteAuth).mockReset();
  vi.mocked(createUsdcClaimAuth).mockReset();
  vi.mocked(payUsdcFromWalletAuth).mockReset();
  vi.mocked(getUsdcPaymentStatusAuth).mockReset();
  vi.mocked(getUsdcPaymentStatusAuth).mockResolvedValue(makeWalletPayResult());
  vi.mocked(getDashboardStepUpToken).mockReturnValue(null);
  vi.mocked(requestStepUpToken).mockResolvedValue('step-up-token');
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
    expect(screen.queryByText(/Paid and settled/)).not.toBeInTheDocument();
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
    // No settlement claim from a 409 in-progress alone.
    expect(screen.queryByText(/Payment received and settled/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Paid and settled/)).not.toBeInTheDocument();
    // onChange may be called only if a subsequent status reports paid — not from this 409.
    expect(onChange).not.toHaveBeenCalled();
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

describe('UsdcPaymentPanel — quote facts and wallet pay', () => {
  it('renders server-derived quote facts (amount, token, payer, treasury, expiry)', async () => {
    const quote = makeQuote({
      amountUsd: '12.50',
      amountBaseUnits: '12500000',
      tokenAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      expectedPayerAddress: '0x1111111111111111111111111111111111111111',
      treasuryAddress: '0x2222222222222222222222222222222222222222',
      chainId: 84532,
    });
    vi.mocked(createUsdcQuoteAuth).mockResolvedValue(quote);
    vi.mocked(getUsdcPaymentStatusAuth).mockResolvedValue(makeWalletPayResult());

    renderPanel();

    expect(await screen.findByText('12.50')).toBeInTheDocument();
    expect(screen.getByText(/12\.5 USDC/)).toBeInTheDocument();
    expect(screen.getByText(quote.tokenAddress)).toBeInTheDocument();
    expect(screen.getByText(quote.expectedPayerAddress)).toBeInTheDocument();
    expect(screen.getByText(quote.treasuryAddress)).toBeInTheDocument();
    expect(screen.getByText(/Required sender \(SOFA wallet\)/i)).toBeInTheDocument();
    expect(screen.getByText(/USDC token contract/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Pay from wallet/i })).toBeInTheDocument();
  });

  it('does not auto-submit wallet pay on quote load', async () => {
    vi.mocked(createUsdcQuoteAuth).mockResolvedValue(makeQuote());
    vi.mocked(getUsdcPaymentStatusAuth).mockResolvedValue(makeWalletPayResult());

    renderPanel();
    await screen.findByRole('button', { name: /Pay from wallet/i });

    expect(payUsdcFromWalletAuth).not.toHaveBeenCalled();
  });

  it('pay from wallet sends only paymentAttemptId with step-up and does not treat accepted as paid', async () => {
    const { onChange, getToken } = await renderWithQuote();

    vi.mocked(payUsdcFromWalletAuth).mockResolvedValue(
      makeWalletPayResult({
        accepted: true,
        reserved: true,
        phase: 'accepted',
        paid: false,
        status: 'pending',
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Pay from wallet/i }));

    await waitFor(() => expect(payUsdcFromWalletAuth).toHaveBeenCalledTimes(1));
    expect(payUsdcFromWalletAuth).toHaveBeenCalledWith(
      getToken,
      'inv_1',
      'attempt_1',
      'step-up-token',
    );

    expect(await screen.findByText(/Payment accepted/i)).toBeInTheDocument();
    expect(screen.getByText(/Acceptance is not settlement/i)).toBeInTheDocument();
    expect(screen.queryByText(/Paid and settled/i)).not.toBeInTheDocument();
    // Not settled → invoice refresh not forced from paid path
    expect(onChange).not.toHaveBeenCalled();

    // Duplicate pay disabled while reserved/accepted
    expect(payFromWalletButton()).toBeDisabled();
  });

  it('marks paid only when server returns paid: true', async () => {
    const { onChange } = await renderWithQuote();

    vi.mocked(payUsdcFromWalletAuth).mockResolvedValue(
      makeWalletPayResult({
        accepted: true,
        reserved: true,
        phase: 'paid',
        paid: true,
        status: 'succeeded',
        transactionHash: VALID_TX_HASH,
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Pay from wallet/i }));

    expect(await screen.findByText(/Paid and settled/i)).toBeInTheDocument();
    await waitFor(() => expect(onChange).toHaveBeenCalled());
  });

  it('does not treat transaction hash alone as paid when paid is false', async () => {
    const { onChange } = await renderWithQuote();

    const confirming = makeWalletPayResult({
      accepted: true,
      reserved: true,
      phase: 'status',
      paid: false,
      status: 'confirming',
      transactionHash: VALID_TX_HASH,
    });
    vi.mocked(payUsdcFromWalletAuth).mockResolvedValue(confirming);
    // Polls must keep the same non-paid confirming state.
    vi.mocked(getUsdcPaymentStatusAuth).mockResolvedValue(confirming);

    fireEvent.click(screen.getByRole('button', { name: /Pay from wallet/i }));

    expect(await screen.findByText(/Confirming on-chain/i)).toBeInTheDocument();
    expect(screen.queryByText(/Paid and settled/i)).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows unknown/manual review and locks actions without claiming settlement', async () => {
    const { onChange } = await renderWithQuote();

    vi.mocked(payUsdcFromWalletAuth).mockResolvedValue(
      makeWalletPayResult({
        accepted: true,
        reserved: true,
        phase: 'unknown',
        paid: false,
        status: 'needs_review',
        reviewReason: 'wallet_payment_dispatch_unknown',
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Pay from wallet/i }));

    expect(await screen.findByText(/Manual review required/i)).toBeInTheDocument();
    expect(screen.getByText(/wallet_payment_dispatch_unknown/)).toBeInTheDocument();
    expect(screen.queryByText(/Paid and settled/i)).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(payFromWalletButton()).toBeDisabled();
    expect(claimButton()).toBeDisabled();
  });

  it('restores reserved wallet payment state from status after quote load', async () => {
    vi.mocked(createUsdcQuoteAuth).mockResolvedValue(makeQuote());
    vi.mocked(getUsdcPaymentStatusAuth).mockResolvedValue(
      makeWalletPayResult({
        reserved: true,
        accepted: true,
        phase: 'submitting',
        paid: false,
        status: 'pending',
      }),
    );

    renderPanel();

    expect(await screen.findByText(/Submitting payment/i)).toBeInTheDocument();
    expect(payFromWalletButton()).toBeDisabled();
    expect(payUsdcFromWalletAuth).not.toHaveBeenCalled();
  });

  it('surfaces usage-debt and expiry-too-soon errors safely', async () => {
    await renderWithQuote();

    vi.mocked(payUsdcFromWalletAuth).mockRejectedValue(
      apiError(400, { code: 'USDC_WALLET_USAGE_DEBT_ONLY' }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Pay from wallet/i }));
    expect(await screen.findByText(/Usage debt is open/i)).toBeInTheDocument();

    vi.mocked(payUsdcFromWalletAuth).mockRejectedValue(
      apiError(400, { code: 'USDC_QUOTE_EXPIRY_TOO_SOON' }),
    );
    // Re-enable by clearing prior lock (no lock from error alone)
    fireEvent.click(screen.getByRole('button', { name: /Pay from wallet/i }));
    expect(
      await screen.findByText(/expires too soon to start a wallet payment/i),
    ).toBeInTheDocument();
  });

  it('surfaces step-up failure without leaking provider details', async () => {
    await renderWithQuote();

    vi.mocked(payUsdcFromWalletAuth).mockRejectedValue(
      apiError(403, {
        code: 'FORBIDDEN',
        message: 'Invalid or expired step-up verification. Please verify again.',
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Pay from wallet/i }));

    expect(
      await screen.findByText(/Authenticator confirmation expired or is missing/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/openfort/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/calldata/i)).not.toBeInTheDocument();
  });

  it('Check status refreshes payment state without submitting pay', async () => {
    await renderWithQuote();
    vi.mocked(getUsdcPaymentStatusAuth).mockClear();

    vi.mocked(getUsdcPaymentStatusAuth).mockResolvedValue(
      makeWalletPayResult({
        reserved: true,
        accepted: true,
        phase: 'status',
        status: 'confirming',
        paid: false,
        transactionHash: VALID_TX_HASH,
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Check status/i }));

    expect(await screen.findByText(/Confirming on-chain/i)).toBeInTheDocument();
    expect(payUsdcFromWalletAuth).not.toHaveBeenCalled();
    expect(getUsdcPaymentStatusAuth).toHaveBeenCalled();
  });
});

describe('UsdcPaymentPanel — fail-closed recovery (B5)', () => {
  it('locks pay and manual claim when quote restores but payment-status returns 503', async () => {
    vi.mocked(createUsdcQuoteAuth).mockResolvedValue(makeQuote());
    vi.mocked(getUsdcPaymentStatusAuth).mockRejectedValue(
      apiError(503, { code: 'INTERNAL_ERROR', message: 'Service unavailable' }),
    );

    renderPanel();

    expect(await screen.findByText(/Status unconfirmed/i)).toBeInTheDocument();
    expect(screen.getByText(/Payment status could not be confirmed/i)).toBeInTheDocument();
    expect(payFromWalletButton()).toBeDisabled();
    expect(claimButton()).toBeDisabled();
    expect(payUsdcFromWalletAuth).not.toHaveBeenCalled();
    // Only safe retry is Check status.
    expect(screen.getByRole('button', { name: /Check status/i })).not.toBeDisabled();
  });

  it('keeps actions locked after reserved restore if a later status check fails with 503', async () => {
    const reserved = makeWalletPayResult({
      reserved: true,
      accepted: true,
      phase: 'submitting',
      paid: false,
      status: 'pending',
    });
    vi.mocked(createUsdcQuoteAuth).mockResolvedValue(makeQuote());
    vi.mocked(getUsdcPaymentStatusAuth).mockResolvedValueOnce(reserved);

    renderPanel();
    expect(await screen.findByText(/Submitting payment/i)).toBeInTheDocument();
    expect(payFromWalletButton()).toBeDisabled();

    vi.mocked(getUsdcPaymentStatusAuth).mockRejectedValue(
      apiError(503, { code: 'INTERNAL_ERROR', message: 'Service unavailable' }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Check status/i }));

    expect(await screen.findByText(/Status unconfirmed/i)).toBeInTheDocument();
    expect(payFromWalletButton()).toBeDisabled();
    expect(claimButton()).toBeDisabled();
    expect(payUsdcFromWalletAuth).not.toHaveBeenCalled();
  });

  it('enters pay-ambiguous recovery on client timeout after possible acceptance and blocks duplicate pay/claim', async () => {
    await renderWithQuote();

    vi.mocked(payUsdcFromWalletAuth).mockRejectedValue(new TypeError('Failed to fetch'));

    fireEvent.click(screen.getByRole('button', { name: /Pay from wallet/i }));

    expect(await screen.findByText(/Payment result unconfirmed/i)).toBeInTheDocument();
    expect(screen.getByText(/may already have accepted/i)).toBeInTheDocument();
    expect(screen.queryByText(/Paid and settled/i)).not.toBeInTheDocument();
    expect(payFromWalletButton()).toBeDisabled();
    expect(claimButton()).toBeDisabled();

    // A second click must not fire another pay.
    fireEvent.click(screen.getByRole('button', { name: /Pay from wallet/i }));
    expect(payUsdcFromWalletAuth).toHaveBeenCalledTimes(1);
  });

  it('clears pay-ambiguous recovery only after a successful authoritative status check', async () => {
    await renderWithQuote();

    vi.mocked(payUsdcFromWalletAuth).mockRejectedValue(new TypeError('network timeout'));
    fireEvent.click(screen.getByRole('button', { name: /Pay from wallet/i }));
    expect(await screen.findByText(/Payment result unconfirmed/i)).toBeInTheDocument();

    vi.mocked(getUsdcPaymentStatusAuth).mockResolvedValue(
      makeWalletPayResult({
        reserved: true,
        accepted: true,
        phase: 'status',
        status: 'confirming',
        paid: false,
        transactionHash: VALID_TX_HASH,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Check status/i }));

    expect(await screen.findByText(/Confirming on-chain/i)).toBeInTheDocument();
    expect(screen.queryByText(/Payment result unconfirmed/i)).not.toBeInTheDocument();
    expect(payFromWalletButton()).toBeDisabled();
    expect(claimButton()).toBeDisabled();
    expect(screen.queryByText(/Paid and settled/i)).not.toBeInTheDocument();
  });
});
