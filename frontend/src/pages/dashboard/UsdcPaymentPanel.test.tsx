import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UsdcPaymentPanel } from './UsdcPaymentPanel';
import {
  cancelUsdcQuoteAuth,
  createUsdcClaimAuth,
  createUsdcQuoteAuth,
  getInvoicePaymentStatusAuth,
  getUsdcPaymentStatusAuth,
  payUsdcFromWalletAuth,
  type BillingInvoice,
} from '@/lib/api';
import {
  apiError,
  makeInvoicePaymentStatus,
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
    cancelUsdcQuoteAuth: vi.fn(),
    payUsdcFromWalletAuth: vi.fn(),
    getUsdcPaymentStatusAuth: vi.fn(),
    getInvoicePaymentStatusAuth: vi.fn(),
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
    wallets: Array<{ id: string; walletAddress: string | null; isDefault?: boolean; status: string }>;
    walletChoicesError: string | null;
  }> = {},
) {
  const getToken = vi.fn().mockResolvedValue('test-token');
  const onChange = over.onChange ?? vi.fn().mockResolvedValue(true);
  const invoice = over.invoice ?? makePayableInvoice('inv_1');

  const view = render(
    <UsdcPaymentPanel invoice={invoice} getToken={getToken} onChange={onChange} wallets={over.wallets ?? []} walletChoicesError={over.walletChoicesError} />,
  );

  return { view, onChange, invoice, getToken };
}

/** Render the panel, request a quote (user-triggered), and wait until the claim form is usable. */
async function renderWithQuote() {
  vi.mocked(getInvoicePaymentStatusAuth).mockResolvedValue(makeInvoicePaymentStatus());
  vi.mocked(createUsdcQuoteAuth).mockResolvedValue(makeQuote());
  vi.mocked(getUsdcPaymentStatusAuth).mockResolvedValue(makeWalletPayResult());

  const ctx = renderPanel();

  // BILL-018: panel loads invoice status only — user must request a quote.
  const getQuoteButton = await screen.findByRole('button', { name: /Get quote/i });
  // The control may render while the mount-time invoice-status request is still
  // pending. The quote action is disabled until that authoritative read finishes.
  await waitFor(() => expect(getQuoteButton).toBeEnabled());
  fireEvent.click(getQuoteButton);

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
  vi.mocked(cancelUsdcQuoteAuth).mockReset();
  vi.mocked(payUsdcFromWalletAuth).mockReset();
  vi.mocked(getUsdcPaymentStatusAuth).mockReset();
  vi.mocked(getInvoicePaymentStatusAuth).mockReset();
  vi.mocked(getUsdcPaymentStatusAuth).mockResolvedValue(makeWalletPayResult());
  vi.mocked(getInvoicePaymentStatusAuth).mockResolvedValue(makeInvoicePaymentStatus());
  vi.mocked(cancelUsdcQuoteAuth).mockResolvedValue({
    invoiceId: 'inv_1',
    paymentAttemptId: 'attempt_1',
    status: 'cancelled',
    cancelledAt: '2026-08-01T12:00:00.000Z',
    cancelReason: 'user_requested',
  });
  vi.mocked(getDashboardStepUpToken).mockReturnValue(null);
  vi.mocked(requestStepUpToken).mockResolvedValue('step-up-token');
  vi.spyOn(window, 'confirm').mockReturnValue(true);
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
    vi.mocked(getInvoicePaymentStatusAuth).mockResolvedValue(makeInvoicePaymentStatus());
    vi.mocked(createUsdcQuoteAuth).mockResolvedValue(quote);
    vi.mocked(getUsdcPaymentStatusAuth).mockResolvedValue(makeWalletPayResult());

    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Get quote/i }));

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
    vi.mocked(getInvoicePaymentStatusAuth).mockResolvedValue(makeInvoicePaymentStatus());
    vi.mocked(createUsdcQuoteAuth).mockResolvedValue(makeQuote());
    vi.mocked(getUsdcPaymentStatusAuth).mockResolvedValue(makeWalletPayResult());

    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Get quote/i }));
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
    vi.mocked(getInvoicePaymentStatusAuth).mockResolvedValue(makeInvoicePaymentStatus());
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
    fireEvent.click(await screen.findByRole('button', { name: /Get quote/i }));

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
    vi.mocked(getInvoicePaymentStatusAuth).mockResolvedValue(makeInvoicePaymentStatus());
    vi.mocked(createUsdcQuoteAuth).mockResolvedValue(makeQuote());
    vi.mocked(getUsdcPaymentStatusAuth).mockRejectedValue(
      apiError(503, { code: 'INTERNAL_ERROR', message: 'Service unavailable' }),
    );

    renderPanel();
    const getQuoteButton = await screen.findByRole('button', { name: /Get quote/i });
    await waitFor(() => expect(getQuoteButton).toBeEnabled());
    fireEvent.click(getQuoteButton);

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
    vi.mocked(getInvoicePaymentStatusAuth).mockResolvedValue(makeInvoicePaymentStatus());
    vi.mocked(createUsdcQuoteAuth).mockResolvedValue(makeQuote());
    vi.mocked(getUsdcPaymentStatusAuth).mockResolvedValueOnce(reserved);

    renderPanel();
    const getQuoteButton = await screen.findByRole('button', { name: /Get quote/i });
    // The quote control can render before the mount-time invoice status read completes.
    // Wait for that authoritative read so the click cannot be ignored while disabled.
    await waitFor(() => expect(getQuoteButton).toBeEnabled());
    fireEvent.click(getQuoteButton);
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

describe('UsdcPaymentPanel — BILL-018 invoice payment status recovery', () => {
  it('does not auto-create a quote on open; only loads invoice-level payment status', async () => {
    vi.mocked(getInvoicePaymentStatusAuth).mockResolvedValue(makeInvoicePaymentStatus());
    renderPanel();

    expect(await screen.findByRole('button', { name: /Get quote/i })).toBeInTheDocument();
    expect(createUsdcQuoteAuth).not.toHaveBeenCalled();
    expect(getInvoicePaymentStatusAuth).toHaveBeenCalled();
    expect(screen.queryByLabelText('Transaction hash')).not.toBeInTheDocument();
  });

  it('blocks new quotes when unresolved needs_review is restored from the server', async () => {
    vi.mocked(getInvoicePaymentStatusAuth).mockResolvedValue(
      makeInvoicePaymentStatus({
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

    renderPanel();

    expect(await screen.findByText(/Payment needs manual review/i)).toBeInTheDocument();
    expect(
      screen.getByText(/already applied to another invoice/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Get quote/i })).not.toBeInTheDocument();
    expect(createUsdcQuoteAuth).not.toHaveBeenCalled();
    // Safe recovery must not leak hashes or provider details.
    expect(screen.queryByText(/0x/i)).not.toBeInTheDocument();
  });

  it('shows continue entry for an active pending USDC quote without auto-quoting', async () => {
    vi.mocked(getInvoicePaymentStatusAuth).mockResolvedValue(
      makeInvoicePaymentStatus({
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

    renderPanel();

    expect(await screen.findByText(/USDC payment in progress/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue this payment/i })).toBeInTheDocument();
    expect(createUsdcQuoteAuth).not.toHaveBeenCalled();

    vi.mocked(createUsdcQuoteAuth).mockResolvedValue(makeQuote({ paymentAttemptId: 'att_pending' }));
    vi.mocked(getUsdcPaymentStatusAuth).mockResolvedValue(makeWalletPayResult());

    fireEvent.click(screen.getByRole('button', { name: /Continue this payment/i }));

    expect(await screen.findByLabelText('Transaction hash')).toBeInTheDocument();
    expect(createUsdcQuoteAuth).toHaveBeenCalled();
    // Quote path always re-reads invoice status first.
    expect(vi.mocked(getInvoicePaymentStatusAuth).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses Get quote when invoice-level status reports unresolved review', async () => {
    vi.mocked(getInvoicePaymentStatusAuth)
      .mockResolvedValueOnce(makeInvoicePaymentStatus())
      .mockResolvedValueOnce(
        makeInvoicePaymentStatus({
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

    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Get quote/i }));

    expect(
      await screen.findByText(/still needs manual review/i),
    ).toBeInTheDocument();
    expect(createUsdcQuoteAuth).not.toHaveBeenCalled();
  });
});

describe('UsdcPaymentPanel — BILL-003 cancel clean pending quote', () => {
  const cancelButton = () =>
    screen.queryByRole('button', { name: /Cancel this unused USDC quote/i });

  it('shows Cancel quote for a clean idle pending quote and cancels after confirm', async () => {
    const { onChange, getToken } = await renderWithQuote();

    expect(cancelButton()).toBeInTheDocument();
    expect(cancelButton()).not.toBeDisabled();

    fireEvent.click(cancelButton()!);

    await waitFor(() => expect(cancelUsdcQuoteAuth).toHaveBeenCalledTimes(1));
    expect(cancelUsdcQuoteAuth).toHaveBeenCalledWith(getToken, 'inv_1', 'attempt_1');
    expect(window.confirm).toHaveBeenCalled();
    expect(await screen.findByText(/USDC quote cancelled/i)).toBeInTheDocument();
    // Local quote cleared so claim/pay are gone until a new quote.
    expect(claimButton()).not.toBeInTheDocument();
    expect(payFromWalletButton()).not.toBeInTheDocument();
    expect(onChange).toHaveBeenCalled();
    // Status refreshed after cancel (initial + after cancel at least).
    expect(vi.mocked(getInvoicePaymentStatusAuth).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('does not call cancel when the user dismisses confirmation', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    await renderWithQuote();

    fireEvent.click(cancelButton()!);
    expect(cancelUsdcQuoteAuth).not.toHaveBeenCalled();
  });

  it('hides Cancel quote while wallet payment is reserved or confirming', async () => {
    await renderWithQuote();

    // After pay reserved, cancel must disappear (confirming/reserved block).
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
    expect(await screen.findByText(/Payment accepted/i)).toBeInTheDocument();
    expect(cancelButton()).not.toBeInTheDocument();
  });

  it('hides Cancel quote on continue entry when status is confirming', async () => {
    vi.mocked(getInvoicePaymentStatusAuth).mockResolvedValue(
      makeInvoicePaymentStatus({
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

    renderPanel();
    expect(await screen.findByText(/USDC payment confirming/i)).toBeInTheDocument();
    expect(cancelButton()).not.toBeInTheDocument();
  });

  it('hides Cancel quote when wallet reservation is active on continue entry', async () => {
    vi.mocked(getInvoicePaymentStatusAuth).mockResolvedValue(
      makeInvoicePaymentStatus({
        walletReservation: {
          paymentAttemptId: 'att_reserved',
          method: 'usdc',
          status: 'pending',
          reviewReason: null,
          createdAt: '2026-08-01T00:00:00.000Z',
          walletPaymentReserved: true,
          chainId: 84532,
          quoteExpiresAt: '2099-12-31T23:59:59.000Z',
        },
        activeAttempt: {
          paymentAttemptId: 'att_reserved',
          method: 'usdc',
          status: 'pending',
          reviewReason: null,
          createdAt: '2026-08-01T00:00:00.000Z',
          walletPaymentReserved: true,
          chainId: 84532,
          quoteExpiresAt: '2099-12-31T23:59:59.000Z',
        },
      }),
    );

    renderPanel();
    expect(await screen.findByText(/Wallet payment reserved/i)).toBeInTheDocument();
    expect(cancelButton()).not.toBeInTheDocument();
  });

  it('shows Cancel on clean pending continue entry and cancels without opening a quote first', async () => {
    vi.mocked(getInvoicePaymentStatusAuth)
      .mockResolvedValueOnce(
        makeInvoicePaymentStatus({
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
      .mockResolvedValue(makeInvoicePaymentStatus());

    const { onChange, getToken } = renderPanel();
    expect(await screen.findByText(/USDC payment in progress/i)).toBeInTheDocument();
    expect(cancelButton()).toBeInTheDocument();

    fireEvent.click(cancelButton()!);

    await waitFor(() => expect(cancelUsdcQuoteAuth).toHaveBeenCalledTimes(1));
    expect(cancelUsdcQuoteAuth).toHaveBeenCalledWith(getToken, 'inv_1', 'att_pending');
    expect(await screen.findByText(/USDC quote cancelled/i)).toBeInTheDocument();
    expect(onChange).toHaveBeenCalled();
    // Never auto-quoted.
    expect(createUsdcQuoteAuth).not.toHaveBeenCalled();
  });

  it('USDC_CANCEL_NOT_ALLOWED shows conflict copy, refreshes status, and does not claim cancel success', async () => {
    await renderWithQuote();

    vi.mocked(cancelUsdcQuoteAuth).mockRejectedValue(
      apiError(409, { code: 'USDC_CANCEL_NOT_ALLOWED' }),
    );
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

    fireEvent.click(cancelButton()!);

    expect(
      await screen.findByText(/can no longer be cancelled/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/USDC quote cancelled/i)).not.toBeInTheDocument();
    // Status refresh path after 409.
    await waitFor(() =>
      expect(getUsdcPaymentStatusAuth).toHaveBeenCalledWith(
        expect.any(Function),
        'inv_1',
        'attempt_1',
        undefined,
      ),
    );
    expect(await screen.findByText(/Confirming on-chain/i)).toBeInTheDocument();
    // After confirming, cancel control must not remain misleadingly enabled.
    expect(cancelButton()).not.toBeInTheDocument();
  });

  it('prevents duplicate cancel submits while a cancel is in flight', async () => {
    let resolveCancel: (value: unknown) => void = () => undefined;
    vi.mocked(cancelUsdcQuoteAuth).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCancel = resolve as (value: unknown) => void;
        }),
    );

    await renderWithQuote();
    fireEvent.click(cancelButton()!);

    // Aria-label stays stable; visible label switches to Canceling… and stays disabled.
    const loadingBtn = await screen.findByRole('button', {
      name: /Cancel this unused USDC quote/i,
    });
    expect(loadingBtn).toBeDisabled();
    expect(loadingBtn).toHaveTextContent(/Canceling/i);
    fireEvent.click(loadingBtn);
    expect(cancelUsdcQuoteAuth).toHaveBeenCalledTimes(1);

    resolveCancel({
      invoiceId: 'inv_1',
      paymentAttemptId: 'attempt_1',
      status: 'cancelled',
      cancelledAt: '2026-08-01T12:00:00.000Z',
      cancelReason: 'user_requested',
    });
    expect(await screen.findByText(/USDC quote cancelled/i)).toBeInTheDocument();
  });
  it('requires an explicit payer and binds the quote to the chosen wallet', async () => {
    const wallets = [
      { id: 'wallet-a', walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', status: 'active' },
      { id: 'wallet-b', walletAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', status: 'active' },
    ];
    vi.mocked(createUsdcQuoteAuth).mockResolvedValue(makeQuote());
    renderPanel({ wallets });
    await screen.findByRole('button', { name: /Get quote/i });
    fireEvent.click(screen.getByRole('button', { name: /Get quote/i }));
    expect(createUsdcQuoteAuth).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Paying wallet'), { target: { value: 'wallet-a' } });
    fireEvent.click(screen.getByRole('button', { name: /Get quote/i }));
    await waitFor(() => expect(createUsdcQuoteAuth).toHaveBeenCalledWith(expect.any(Function), 'inv_1', 84532, undefined, 'wallet-a'));
  });

  it('does not display an A quote after payer choices arrive and change to B in flight', async () => {
    let resolveQuote!: (value: ReturnType<typeof makeQuote>) => void;
    vi.mocked(createUsdcQuoteAuth).mockReturnValue(new Promise((resolve) => { resolveQuote = resolve; }));
    const initial = renderPanel();
    await screen.findByRole('button', { name: /Get quote/i });
    fireEvent.click(screen.getByRole('button', { name: /Get quote/i }));
    initial.view.rerender(<UsdcPaymentPanel invoice={initial.invoice} getToken={initial.getToken} onChange={initial.onChange} wallets={[{ id: 'wallet-a', walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', status: 'active' }, { id: 'wallet-b', walletAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', status: 'active' }]} />);
    fireEvent.change(await screen.findByLabelText('Paying wallet'), { target: { value: 'wallet-b' } });
    resolveQuote(makeQuote());
    await waitFor(() => expect(screen.queryByText('12.50')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Paying wallet')).toHaveValue('wallet-b');
  });
});
