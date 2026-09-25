import {
  ApiError,
  type BillingInvoice,
  type BillingInvoicesResponse,
  type BillingPlanResponse,
  type BillingSummary,
  type InvoicePaymentStatus,
  type UsdcQuoteResponse,
  type UsdcWalletPayResult,
} from '@/lib/api';

/** Wrap a list of invoices in the exact response shape `listBillingInvoicesAuth` returns. */
export function invoicesResponse(
  items: BillingInvoice[],
  over: Partial<Omit<BillingInvoicesResponse, 'items'>> = {},
): BillingInvoicesResponse {
  return { items, total: items.length, page: 1, limit: 20, ...over };
}

/** Build a BillingInvoice with safe defaults; override what the test needs. */
export function makeInvoice(over: Partial<BillingInvoice> & { id: string }): BillingInvoice {
  return {
    period: '2026-08',
    status: 'open',
    amount: '10.00',
    currency: 'USD',
    createdAt: '2026-08-01T00:00:00.000Z',
    paidAt: null,
    pdfUrl: null,
    planVersionId: null,
    ...over,
  };
}

/** A finalized, unpaid, USD invoice eligible for both card and USDC payment. */
export function makePayableInvoice(id = 'inv_1'): BillingInvoice {
  return makeInvoice({
    id,
    status: 'finalized',
    amount: '10.00',
    currency: 'USD',
  });
}

export function makePaidInvoice(id = 'inv_1'): BillingInvoice {
  return makeInvoice({
    id,
    status: 'paid',
    amount: '10.00',
    currency: 'USD',
    paidAt: '2026-08-05T00:00:00.000Z',
  });
}

export function makePlans(): BillingPlanResponse {
  return {
    currentPlanId: 'plan_starter',
    renewal: {
      status: 'disabled',
      subscriptionStatus: 'none',
      paymentMethod: 'none',
      nextChargeAt: null,
      amount: null,
      currency: null,
    },
    plans: [
      {
        id: 'plan_starter',
        name: 'Starter',
        description: 'Starter plan',
        basePrice: '0.00',
        currency: 'USD',
        billingPeriod: 'Monthly',
        features: ['Outbound volume'],
      },
      {
        id: 'plan_pro',
        name: 'Pro',
        description: 'Pro plan',
        basePrice: '49.00',
        currency: 'USD',
        billingPeriod: 'Monthly',
        features: ['Outbound volume'],
      },
    ],
  };
}

export function makeSummary(): BillingSummary {
  return {
    period: '2026-08',
    planId: 'plan_starter',
    planName: 'Starter',
    outboundVolume: '0',
    outboundFreeAllowance: '1000',
    outboundOverage: '0',
    apiCalls: '10',
    apiCallsFreeAllowance: '1000',
    activeWallets: '1',
    activeWalletsFreeAllowance: '1',
    estimatedBaseCost: '0.00',
    estimatedOverageCost: '0.00',
    estimatedTotal: '0.00',
    currency: 'USD',
    overageRate: '0.00',
    overageUnit: 'MB',
    tierBreakdown: [],
  };
}

export function makeQuote(over?: Partial<UsdcQuoteResponse>): UsdcQuoteResponse {
  return {
    invoiceId: 'inv_1',
    paymentAttemptId: 'attempt_1',
    chainId: 84532,
    tokenAddress: '0x0000000000000000000000000000000000000001',
    tokenDecimals: 6,
    treasuryAddress: '0x0000000000000000000000000000000000000002',
    expectedPayerAddress: '0x0000000000000000000000000000000000000003',
    amountBaseUnits: '10000000',
    amountUsd: '10.00',
    currency: 'USD',
    // Far-future default so wallet-pay expiry guards stay open in unit tests.
    quoteExpiresAt: '2099-12-31T23:59:59.000Z',
    requiredConfirmations: 1,
    ...over,
  };
}

export function makeWalletPayResult(over?: Partial<UsdcWalletPayResult>): UsdcWalletPayResult {
  return {
    invoiceId: 'inv_1',
    paymentAttemptId: 'attempt_1',
    status: 'pending',
    paid: false,
    accepted: false,
    reserved: false,
    isExecutor: false,
    phase: 'status',
    chainId: 84532,
    transactionHash: null,
    reviewReason: null,
    ...over,
  };
}

/** BILL-018 invoice-level payment status (safe fields only). */
export function makeInvoicePaymentStatus(
  over?: Partial<InvoicePaymentStatus>,
): InvoicePaymentStatus {
  return {
    invoiceId: 'inv_1',
    invoiceStatus: 'finalized',
    paid: false,
    paidAt: null,
    activeAttempt: null,
    walletReservation: null,
    unresolvedReviewAttempts: [],
    hasUnresolvedReview: false,
    blockingReasons: [],
    ...over,
  };
}

export const VALID_TX_HASH = `0x${'a'.repeat(64)}`;

/** Build a real ApiError like the backend would return (used to exercise error mapping). */
export function apiError(
  status: number,
  body?: Partial<{ message: string; code: string }>,
): ApiError {
  return new ApiError(new Response(null, { status }), {
    statusCode: status,
    code: body?.code ?? `HTTP_${status}`,
    message: body?.message ?? `Request failed: ${status}`,
  });
}
