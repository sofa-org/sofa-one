import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  Clock,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import { CopyButton } from '@/components/CopyButton';
import {
  createUsdcClaimAuth,
  createUsdcQuoteAuth,
  getUsdcPaymentStatusAuth,
  hasApiErrorCode,
  isApiError,
  payUsdcFromWalletAuth,
  type BillingInvoice,
  type UsdcClaimResponse,
  type UsdcClaimStatus,
  type UsdcQuoteResponse,
  type UsdcWalletPayResult,
} from '@/lib/api';
import { requestStepUpToken } from './step-up';
import { getDashboardStepUpToken } from './step-up-session';

const USDC_CHAIN_OPTIONS: Array<{ chainId: number; name: string; explorer: string }> = [
  { chainId: 8453, name: 'Base Mainnet', explorer: 'https://basescan.org' },
  { chainId: 84532, name: 'Base Sepolia', explorer: 'https://sepolia.basescan.org' },
  { chainId: 1, name: 'Ethereum Mainnet', explorer: 'https://etherscan.io' },
  { chainId: 11155111, name: 'Ethereum Sepolia', explorer: 'https://sepolia.etherscan.io' },
];

/** Match backend wallet-pay expiry safety margin (5 minutes). */
const QUOTE_EXPIRY_WARNING_MS = 5 * 60 * 1000;

const WALLET_STATUS_POLL_INTERVAL_MS = 2000;
const WALLET_STATUS_MAX_POLLS = 12;

function getChainOption(chainId: number) {
  return USDC_CHAIN_OPTIONS.find((option) => option.chainId === chainId) ?? null;
}

function formatBaseUnits(amountBaseUnits: string | null | undefined, decimals: number): string {
  if (amountBaseUnits === null || amountBaseUnits === undefined || amountBaseUnits === '') {
    return '—';
  }
  if (!Number.isFinite(decimals) || decimals < 0) return amountBaseUnits;
  const trimmed = amountBaseUnits.replace(/^0+/, '') || '0';
  if (decimals <= 0) return trimmed;
  const padded = trimmed.padStart(decimals + 1, '0');
  const integerPart = padded.slice(0, -decimals);
  const fractionalPart = padded.slice(-decimals).replace(/0+$/, '');
  return fractionalPart ? `${integerPart}.${fractionalPart}` : integerPart;
}

function isValidTxHash(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value.trim());
}

function formatExpiry(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function quoteExpiryState(quoteExpiresAt: string | null | undefined): {
  expired: boolean;
  expiringSoon: boolean;
  msRemaining: number | null;
} {
  if (!quoteExpiresAt) {
    return { expired: false, expiringSoon: false, msRemaining: null };
  }
  const expiresAt = Date.parse(quoteExpiresAt);
  if (!Number.isFinite(expiresAt)) {
    return { expired: false, expiringSoon: false, msRemaining: null };
  }
  const msRemaining = expiresAt - Date.now();
  return {
    expired: msRemaining <= 0,
    expiringSoon: msRemaining > 0 && msRemaining <= QUOTE_EXPIRY_WARNING_MS,
    msRemaining,
  };
}

function friendlyUsdcError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message === 'Step-up verification cancelled.') {
    return 'Payment cancelled — authenticator confirmation is required to pay from your wallet.';
  }

  if (isApiError(error)) {
    if (error.code === 'USDC_INVOICE_NOT_PAYABLE') {
      return 'This invoice is no longer payable. It may already be paid, finalized, or fully covered. Use another payment method or contact support.';
    }
    if (error.code === 'USDC_PAYMENT_IN_PROGRESS') {
      return 'A USDC payment is already in progress for this invoice. Wait for it to complete, then refresh the quote.';
    }
    if (error.code === 'USDC_INVALID_ATTEMPT') {
      return 'This payment attempt or quote is no longer valid. Request a new quote to continue.';
    }
    if (error.code === 'USDC_WALLET_NOT_ACTIVE' || error.code === 'WALLET_NOT_ACTIVE') {
      return 'Your wallet is not active yet. Finish wallet setup and try again.';
    }
    if (error.code === 'USDC_QUOTE_EXPIRY_TOO_SOON') {
      return 'This quote expires too soon to start a wallet payment safely. Request a fresh quote and try again.';
    }
    if (error.code === 'USDC_WALLET_USAGE_DEBT_ONLY') {
      return 'Usage debt is open. Only usage-period invoices can be paid from your wallet until that debt is settled.';
    }
    if (error.code === 'USDC_WALLET_PAYMENT_RESERVED') {
      return 'A wallet payment is already reserved for this quote. Use Check status instead of starting another payment.';
    }
    if (error.code === 'WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED') {
      return 'The treasury destination is not on your withdrawal allowlist. Add it on the Wallet page first.';
    }
    if (error.code === 'WITHDRAWAL_ADDRESS_IN_COOLDOWN') {
      return 'The treasury destination is still in cooldown. Wait until the cooldown ends, then try again.';
    }
    if (error.code === 'WITHDRAWAL_DESTINATION_POLICY_UNAVAILABLE') {
      return 'Destination policy checks are temporarily unavailable. Try again shortly.';
    }
    if (error.code === 'AUTHENTICATION_REQUIRED' || error.code === 'UNAUTHORIZED') {
      return 'Your session expired. Sign in again, then retry the payment.';
    }
    if (
      error.statusCode === 403 &&
      (error.message.toLowerCase().includes('step-up') ||
        error.message.toLowerCase().includes('step up') ||
        error.message.toLowerCase().includes('authenticator'))
    ) {
      return 'Authenticator confirmation expired or is missing. Confirm with your authenticator code and try again.';
    }
    if (error.statusCode === 403) {
      return 'This action was blocked (frozen account, origin check, or missing permission). Sign in from the dashboard and try again, or contact support.';
    }
    if (error.statusCode === 429) {
      return 'Too many payment attempts. Wait a moment, then try again.';
    }
    if (error.statusCode === 404 || error.statusCode === 501) {
      return 'USDC payments are not available for this invoice. Please use the card option or contact support.';
    }
    if (error.statusCode === 503) {
      return 'USDC payment service is temporarily unavailable. Please try again in a moment.';
    }
    if (error.statusCode === 400) {
      return 'The request was not accepted. Check the selected network and invoice, then try again.';
    }
    if (error.statusCode === 409) {
      return 'A conflict occurred while processing the USDC payment. Please refresh the quote or try again.';
    }
  }
  return fallback;
}

const KNOWN_CLAIM_STATUSES: UsdcClaimStatus[] = [
  'pending',
  'rpc_error',
  'confirming',
  'succeeded',
  'expired',
  'needs_review',
  'failed',
];

function isKnownClaimStatus(status: string): status is UsdcClaimStatus {
  return KNOWN_CLAIM_STATUSES.includes(status as UsdcClaimStatus);
}

function claimStatusDisplay(result: UsdcClaimResponse): {
  message: string;
  tone: 'green' | 'amber' | 'red' | 'blue';
  retryable: boolean;
} {
  const confirmations = result.confirmations ?? 0;
  const required = result.requiredConfirmations ?? null;
  const progress =
    required !== null && required > 0 ? `${confirmations} / ${required} confirmations` : null;

  // Unknown statuses must not default to retryable and should direct users to support.
  if (!isKnownClaimStatus(result.status)) {
    return {
      message: `Unknown payment status (${result.status}). Contact support and do not resubmit unless instructed.`,
      tone: 'amber',
      retryable: false,
    };
  }

  const retryable = result.retryable === true;

  switch (result.status) {
    case 'succeeded':
      if (result.paid === true) {
        return {
          message: 'Payment received and settled. The invoice will update shortly.',
          tone: 'green',
          retryable,
        };
      }
      return {
        message:
          'Payment verified, but the invoice is not settled. It may require manual review. Contact support and do not resubmit unless instructed.',
        tone: 'amber',
        retryable,
      };
    case 'confirming':
      return {
        message: progress
          ? `USDC transfer detected (${progress}). Wait for the required confirmations, then click Refresh quote or re-submit the same transaction hash.`
          : 'USDC transfer detected. Wait for the required confirmations, then re-submit the transaction hash or refresh the quote.',
        tone: 'blue',
        retryable,
      };
    case 'pending':
      return {
        message:
          'Payment not yet detected on-chain. Wait a moment, then re-submit the same transaction hash.',
        tone: 'blue',
        retryable,
      };
    case 'needs_review':
      return {
        message: result.reviewReason
          ? `Under manual review: ${result.reviewReason}. This will not auto-settle — contact support and do not resubmit.`
          : 'Under manual review. This will not auto-settle — contact support and do not resubmit.',
        tone: 'red',
        retryable,
      };
    case 'expired':
      return {
        message: 'This quote has expired. Request a new quote to continue.',
        tone: 'red',
        retryable,
      };
    case 'rpc_error':
    case 'failed':
      return {
        message:
          'The payment could not be confirmed. Check the transaction hash and network, then try again or request a new quote.',
        tone: 'red',
        retryable,
      };
  }
}

/** Local fail-closed recovery when server status is unknown after a possible reservation. */
type WalletPaymentRecovery = {
  kind: 'status_unconfirmed' | 'pay_ambiguous';
  paymentAttemptId: string;
  message: string;
};

const STATUS_UNCONFIRMED_MESSAGE =
  'Payment status could not be confirmed. A wallet payment may already be reserved. Do not pay again or send another transfer — use Check status only.';

const PAY_AMBIGUOUS_MESSAGE =
  'The pay request did not return a clear result. The server may already have accepted it. Do not pay again or claim a manual transfer — use Check status only.';

/**
 * Definite client/server rejections before a reservation can start.
 * Everything else after a pay attempt is treated as ambiguous (fail closed).
 */
function isDefinitePayRejection(error: unknown): boolean {
  if (error instanceof Error && error.message === 'Step-up verification cancelled.') {
    return true;
  }
  if (!isApiError(error)) return false;
  if (
    hasApiErrorCode(
      error,
      'USDC_INVOICE_NOT_PAYABLE',
      'USDC_INVALID_ATTEMPT',
      'USDC_QUOTE_EXPIRY_TOO_SOON',
      'USDC_WALLET_USAGE_DEBT_ONLY',
      'USDC_WALLET_NOT_ACTIVE',
      'WALLET_NOT_ACTIVE',
      'WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED',
      'WITHDRAWAL_ADDRESS_IN_COOLDOWN',
      'WITHDRAWAL_DESTINATION_POLICY_UNAVAILABLE',
      'AUTHENTICATION_REQUIRED',
      'UNAUTHORIZED',
      'VALIDATION_ERROR',
    )
  ) {
    return true;
  }
  // Step-up / origin / frozen 403s are pre-dispatch rejections.
  if (error.statusCode === 403 || error.statusCode === 401) return true;
  if (error.statusCode === 400) return true;
  // Explicit in-progress / reserved conflicts are handled separately (status restore).
  if (
    error.statusCode === 409 &&
    hasApiErrorCode(
      error,
      'USDC_WALLET_PAYMENT_RESERVED',
      'USDC_PAYMENT_IN_PROGRESS',
      'USDC_INVOICE_NOT_PAYABLE',
      'USDC_INVALID_ATTEMPT',
    )
  ) {
    return true;
  }
  return false;
}

function isAmbiguousPayFailure(error: unknown): boolean {
  return !isDefinitePayRejection(error);
}

/**
 * Map wallet-pay / payment-status payloads to UI copy.
 * Never treat accepted, reserved, or transactionHash alone as invoice paid.
 */
function walletPayStatusDisplay(result: UsdcWalletPayResult): {
  title: string;
  message: string;
  tone: 'green' | 'amber' | 'red' | 'blue';
  /** When true, block pay-from-wallet and manual claim. */
  lockActions: boolean;
  /** When true, keep polling status. */
  shouldPoll: boolean;
} {
  // Authoritative settlement only.
  if (result.paid === true) {
    return {
      title: 'Paid and settled',
      message:
        'The server confirmed this invoice is paid. Billing will refresh shortly. Do not send another payment.',
      tone: 'green',
      lockActions: true,
      shouldPoll: false,
    };
  }

  const status = result.status;
  const reviewHint = result.reviewReason
    ? ` Review reason: ${result.reviewReason}.`
    : ' Contact support and do not start another payment unless instructed.';

  if (status === 'needs_review' || result.phase === 'unknown') {
    return {
      title: 'Manual review required',
      message: `This wallet payment needs manual review and is not settled.${reviewHint}`,
      tone: 'amber',
      lockActions: true,
      shouldPoll: false,
    };
  }

  if (status === 'failed') {
    return {
      title: 'Payment failed',
      message:
        'The wallet payment did not complete. Request a new quote before trying again, or contact support if funds may have moved.',
      tone: 'red',
      lockActions: true,
      shouldPoll: false,
    };
  }

  if (status === 'expired') {
    return {
      title: 'Quote expired',
      message: 'This quote expired before settlement. Request a new quote to continue.',
      tone: 'red',
      lockActions: true,
      shouldPoll: false,
    };
  }

  if (status === 'confirming') {
    return {
      title: 'Confirming on-chain',
      message: result.transactionHash
        ? 'A transfer was detected and is waiting for required confirmations. Invoice is not paid yet — status will update when the server settles it.'
        : 'Payment is in progress on-chain. Invoice is not paid yet. Check status again shortly.',
      tone: 'blue',
      lockActions: true,
      shouldPoll: true,
    };
  }

  // phase "status" with a known hash or reservation means in-flight settlement —
  // not a fresh idle quote (backend also uses phase "status" when unreserved).
  if (result.phase === 'status' && (result.reserved || Boolean(result.transactionHash))) {
    return {
      title: 'Confirming on-chain',
      message: result.transactionHash
        ? 'A transfer was detected and is waiting for required confirmations. Invoice is not paid yet — status will update when the server settles it.'
        : 'Payment is in progress on-chain. Invoice is not paid yet. Check status again shortly.',
      tone: 'blue',
      lockActions: true,
      shouldPoll: true,
    };
  }

  if (result.phase === 'submitting') {
    return {
      title: 'Submitting payment',
      message:
        'The server reserved this quote and is submitting the wallet payment. Acceptance is not settlement — wait for confirmation before assuming the invoice is paid.',
      tone: 'blue',
      lockActions: true,
      shouldPoll: true,
    };
  }

  if (result.phase === 'accepted' || result.reserved) {
    return {
      title: 'Payment accepted',
      message:
        'The server accepted this wallet payment and reserved the quote. Acceptance is not settlement — wait for confirmation before assuming the invoice is paid.',
      tone: 'blue',
      lockActions: true,
      shouldPoll: true,
    };
  }

  // Unreserved idle status (fresh quote) — no banner, no lock.
  return {
    title: 'Payment status',
    message: `Current status: ${status}. The invoice is not marked paid yet.`,
    tone: 'blue',
    lockActions: false,
    shouldPoll: false,
  };
}

interface UsdcPaymentPanelProps {
  invoice: BillingInvoice;
  getToken: () => Promise<string | null>;
  onChange: () => Promise<boolean> | boolean;
}

export function UsdcPaymentPanel({ invoice, getToken, onChange }: UsdcPaymentPanelProps) {
  const [selectedChainId, setSelectedChainId] = useState<number>(84532);
  const [quote, setQuote] = useState<UsdcQuoteResponse | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState('');
  const [txHashTouched, setTxHashTouched] = useState(false);
  const [claimLoading, setClaimLoading] = useState(false);
  const [claimResult, setClaimResult] = useState<UsdcClaimResponse | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);

  const [walletPayLoading, setWalletPayLoading] = useState(false);
  const [walletPayResult, setWalletPayResult] = useState<UsdcWalletPayResult | null>(null);
  const [walletPayError, setWalletPayError] = useState<string | null>(null);
  const [statusRefreshing, setStatusRefreshing] = useState(false);
  const [statusPollNote, setStatusPollNote] = useState<string | null>(null);
  /** Fail-closed lock when status is unknown after a possible reservation or ambiguous pay. */
  const [paymentRecovery, setPaymentRecovery] = useState<WalletPaymentRecovery | null>(null);

  const [invoiceRefreshPhase, setInvoiceRefreshPhase] = useState<
    'idle' | 'pending' | 'success' | 'error'
  >('idle');

  const quoteRequestIdRef = useRef(0);
  const statusRequestIdRef = useRef(0);
  const isMountedRef = useRef(true);
  const pollTimerRef = useRef<number | null>(null);
  const pollCountRef = useRef(0);
  const pollAbortRef = useRef<AbortController | null>(null);
  const paymentRecoveryRef = useRef<WalletPaymentRecovery | null>(null);
  const walletPayResultRef = useRef<UsdcWalletPayResult | null>(null);

  paymentRecoveryRef.current = paymentRecovery;
  walletPayResultRef.current = walletPayResult;

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (pollTimerRef.current !== null) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      pollAbortRef.current?.abort();
      pollAbortRef.current = null;
    };
  }, []);

  const stopStatusPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
    pollCountRef.current = 0;
  }, []);

  const formattedUsdcAmount = useMemo(() => {
    if (!quote) return null;
    return `${formatBaseUnits(quote.amountBaseUnits, quote.tokenDecimals)} USDC`;
  }, [quote]);

  const txHashError = useMemo(() => {
    if (!txHashTouched || !txHash.trim()) return null;
    return isValidTxHash(txHash)
      ? null
      : 'Enter a valid transaction hash (0x followed by 64 hex characters).';
  }, [txHash, txHashTouched]);

  const expiry = useMemo(
    () => quoteExpiryState(quote?.quoteExpiresAt),
    // statusPollNote / walletPayResult nudge a re-check while a payment is in flight.
    [quote?.quoteExpiresAt, quote?.paymentAttemptId, statusPollNote, walletPayResult],
  );

  const isActiveWalletPayment = useCallback((data: UsdcWalletPayResult) => {
    if (data.paid === true) return true;
    if (data.reserved === true || data.accepted === true) return true;
    if (data.transactionHash) return true;
    if (data.phase === 'submitting' || data.phase === 'accepted' || data.phase === 'unknown') {
      return true;
    }
    if (
      data.status === 'confirming' ||
      data.status === 'needs_review' ||
      data.status === 'failed' ||
      data.status === 'expired' ||
      data.status === 'succeeded'
    ) {
      return true;
    }
    return false;
  }, []);

  const enterPaymentRecovery = useCallback(
    (kind: WalletPaymentRecovery['kind'], paymentAttemptId: string, message: string) => {
      const next: WalletPaymentRecovery = { kind, paymentAttemptId, message };
      paymentRecoveryRef.current = next;
      setPaymentRecovery(next);
      setWalletPayError(null);
      stopStatusPolling();
      setStatusPollNote(null);
    },
    [stopStatusPolling],
  );

  const clearPaymentRecovery = useCallback(() => {
    paymentRecoveryRef.current = null;
    setPaymentRecovery(null);
  }, []);

  const applyWalletPayResult = useCallback(
    (data: UsdcWalletPayResult, opts?: { fromPoll?: boolean }) => {
      // Authoritative status response clears local recovery — server is the source of truth.
      clearPaymentRecovery();

      // Fresh idle quotes return phase "status" without reservation — keep UI quiet.
      // Polls must not wipe an in-flight result if the status endpoint briefly lags.
      if (!isActiveWalletPayment(data)) {
        if (opts?.fromPoll && isActiveWalletPayment(walletPayResultRef.current ?? data)) {
          // Keep polling; do not unlock from a lagging idle poll while local state is active.
          return { shouldPoll: true };
        }
        setWalletPayResult(null);
        walletPayResultRef.current = null;
        stopStatusPolling();
        setStatusPollNote(null);
        return { shouldPoll: false };
      }

      setWalletPayResult(data);
      walletPayResultRef.current = data;
      setWalletPayError(null);

      // Only invoice paid when the server says so — never from hash/accepted alone.
      if (data.paid === true) {
        stopStatusPolling();
        setStatusPollNote(null);
        void onChange();
        return { shouldPoll: false };
      }

      const display = walletPayStatusDisplay(data);
      if (!display.shouldPoll) {
        stopStatusPolling();
        if (!opts?.fromPoll) setStatusPollNote(null);
        return { shouldPoll: false };
      }
      return { shouldPoll: true };
    },
    [clearPaymentRecovery, isActiveWalletPayment, onChange, stopStatusPolling],
  );

  const fetchPaymentStatus = useCallback(
    async (
      paymentAttemptId: string,
      opts?: { signal?: AbortSignal; fromPoll?: boolean; showSpinner?: boolean },
    ): Promise<UsdcWalletPayResult | null> => {
      const requestId = (statusRequestIdRef.current += 1);
      if (opts?.showSpinner) setStatusRefreshing(true);

      try {
        const data = await getUsdcPaymentStatusAuth(
          getToken,
          invoice.id,
          paymentAttemptId,
          opts?.signal,
        );
        if (opts?.signal?.aborted) return null;
        if (requestId !== statusRequestIdRef.current) return null;
        if (!isMountedRef.current) return null;
        applyWalletPayResult(data, { fromPoll: opts?.fromPoll });
        return data;
      } catch (err: unknown) {
        if (opts?.signal?.aborted) return null;
        if (requestId !== statusRequestIdRef.current) return null;
        if (!isMountedRef.current) return null;

        // Fail closed: never clear reserved/unknown state or unlock pay/claim on status failure.
        // A failed status check always means reservation may exist for this attempt.
        enterPaymentRecovery('status_unconfirmed', paymentAttemptId, STATUS_UNCONFIRMED_MESSAGE);
        return null;
      } finally {
        if (opts?.showSpinner && isMountedRef.current && requestId === statusRequestIdRef.current) {
          setStatusRefreshing(false);
        }
      }
    },
    [applyWalletPayResult, enterPaymentRecovery, getToken, invoice.id],
  );

  const startStatusPolling = useCallback(
    (paymentAttemptId: string) => {
      stopStatusPolling();
      pollCountRef.current = 0;
      setStatusPollNote('Updating payment status automatically…');

      const controller = new AbortController();
      pollAbortRef.current = controller;

      const runCycle = async () => {
        if (!isMountedRef.current || controller.signal.aborted) return;
        if (pollCountRef.current >= WALLET_STATUS_MAX_POLLS) {
          setStatusPollNote(
            'Still waiting for final settlement. Use Check status to refresh, or wait and try again. Do not send another payment.',
          );
          stopStatusPolling();
          return;
        }

        pollCountRef.current += 1;
        const data = await fetchPaymentStatus(paymentAttemptId, {
          signal: controller.signal,
          fromPoll: true,
        });
        if (!isMountedRef.current || controller.signal.aborted) return;

        if (data?.paid === true) {
          setStatusPollNote(null);
          return;
        }

        const display = data ? walletPayStatusDisplay(data) : null;
        if (data && !display?.shouldPoll) {
          setStatusPollNote(null);
          return;
        }

        pollTimerRef.current = window.setTimeout(() => {
          void runCycle();
        }, WALLET_STATUS_POLL_INTERVAL_MS);
      };

      void runCycle();
    },
    [fetchPaymentStatus, stopStatusPolling],
  );

  const fetchQuote = useCallback(
    async (signal?: AbortSignal) => {
      const requestId = (quoteRequestIdRef.current += 1);
      stopStatusPolling();

      const priorRecovery = paymentRecoveryRef.current;
      const priorWallet = walletPayResultRef.current;
      const keepFailClosed =
        priorRecovery !== null || (priorWallet !== null && isActiveWalletPayment(priorWallet));

      // Never wipe reserved/unknown/recovery state while fail-closed — refresh must not
      // re-enable a second payment until the server confirms safe/paid/terminal release.
      if (!keepFailClosed) {
        setQuote(null);
        setQuoteError(null);
        setClaimResult(null);
        setClaimError(null);
        setWalletPayResult(null);
        walletPayResultRef.current = null;
        setWalletPayError(null);
        setStatusPollNote(null);
        clearPaymentRecovery();
        setTxHash('');
        setTxHashTouched(false);
        setInvoiceRefreshPhase('idle');
      } else {
        setQuoteError(null);
        setClaimError(null);
        setWalletPayError(null);
        setStatusPollNote(null);
      }
      setQuoteLoading(true);

      try {
        const data = await createUsdcQuoteAuth(getToken, invoice.id, selectedChainId, signal);
        if (signal?.aborted) return;
        if (requestId !== quoteRequestIdRef.current) return; // stale response
        setQuote(data);
        setSelectedChainId(data.chainId);

        // Restore reserved/in-flight wallet payment from server status (no auto-submit).
        try {
          const status = await getUsdcPaymentStatusAuth(
            getToken,
            invoice.id,
            data.paymentAttemptId,
            signal,
          );
          if (signal?.aborted) return;
          if (requestId !== quoteRequestIdRef.current) return;
          if (!isMountedRef.current) return;

          const applied = applyWalletPayResult(status);
          if (applied.shouldPoll) {
            startStatusPolling(data.paymentAttemptId);
          }
        } catch {
          // Fail closed: status unknown — lock pay/claim; only Check status is safe.
          if (!isMountedRef.current) return;
          if (requestId !== quoteRequestIdRef.current) return;
          enterPaymentRecovery(
            'status_unconfirmed',
            data.paymentAttemptId,
            STATUS_UNCONFIRMED_MESSAGE,
          );
        }
      } catch (err: unknown) {
        if (signal?.aborted) return;
        if (requestId !== quoteRequestIdRef.current) return;
        setQuoteError(
          friendlyUsdcError(
            err,
            'Could not get a USDC quote. Check the selected network and try again.',
          ),
        );
        // Quote restore failed while a reservation may exist — keep locks, do not clear.
        if (keepFailClosed) {
          const attemptId =
            priorRecovery?.paymentAttemptId ?? priorWallet?.paymentAttemptId ?? null;
          if (attemptId) {
            enterPaymentRecovery('status_unconfirmed', attemptId, STATUS_UNCONFIRMED_MESSAGE);
          }
        }
      } finally {
        if (!signal?.aborted && requestId === quoteRequestIdRef.current) {
          setQuoteLoading(false);
        }
      }
    },
    [
      applyWalletPayResult,
      clearPaymentRecovery,
      enterPaymentRecovery,
      getToken,
      invoice.id,
      isActiveWalletPayment,
      selectedChainId,
      startStatusPolling,
      stopStatusPolling,
    ],
  );

  useEffect(() => {
    const controller = new AbortController();
    void fetchQuote(controller.signal);
    return () => controller.abort();
  }, [fetchQuote]);

  const handlePayFromWallet = useCallback(async () => {
    if (!quote || quoteLoading || walletPayLoading) return;
    if (paymentRecoveryRef.current) return;

    const expiryNow = quoteExpiryState(quote.quoteExpiresAt);
    if (expiryNow.expired) {
      setWalletPayError(
        'This quote has expired. Request a new quote before paying from your wallet.',
      );
      return;
    }
    if (expiryNow.expiringSoon) {
      setWalletPayError(
        'This quote expires too soon to start a wallet payment safely. Request a fresh quote and try again.',
      );
      return;
    }

    setWalletPayLoading(true);
    setWalletPayError(null);
    setClaimError(null);
    setClaimResult(null);

    try {
      // Reuse session proof when valid; otherwise prompt via existing step-up helper.
      let stepUpToken = getDashboardStepUpToken();
      if (!stepUpToken) {
        stepUpToken = await requestStepUpToken(getToken);
      }
      if (!stepUpToken) {
        throw new Error('Step-up verification cancelled.');
      }
      const data = await payUsdcFromWalletAuth(
        getToken,
        invoice.id,
        quote.paymentAttemptId,
        stepUpToken,
      );
      if (!isMountedRef.current) return;

      const applied = applyWalletPayResult(data);
      if (applied.shouldPoll) {
        startStatusPolling(quote.paymentAttemptId);
      }
    } catch (err: unknown) {
      if (!isMountedRef.current) return;

      if (isApiError(err) && err.statusCode === 409) {
        if (hasApiErrorCode(err, 'USDC_INVOICE_NOT_PAYABLE')) {
          quoteRequestIdRef.current += 1;
          stopStatusPolling();
          clearPaymentRecovery();
          setQuote(null);
          setQuoteError(null);
          setClaimResult(null);
          setClaimError(null);
          setWalletPayResult(null);
          walletPayResultRef.current = null;
          setWalletPayError(null);
          setTxHash('');
          setTxHashTouched(false);
          setInvoiceRefreshPhase('pending');

          try {
            const refreshed = await onChange();
            if (!isMountedRef.current) return;
            setInvoiceRefreshPhase(refreshed ? 'success' : 'error');
          } catch {
            if (!isMountedRef.current) return;
            setInvoiceRefreshPhase('error');
          }
          return;
        }

        if (hasApiErrorCode(err, 'USDC_WALLET_PAYMENT_RESERVED', 'USDC_PAYMENT_IN_PROGRESS')) {
          // Already reserved — lock via status restore; never invite a second pay.
          enterPaymentRecovery(
            'status_unconfirmed',
            quote.paymentAttemptId,
            STATUS_UNCONFIRMED_MESSAGE,
          );
          void fetchPaymentStatus(quote.paymentAttemptId, { showSpinner: true }).then((status) => {
            if (status && walletPayStatusDisplay(status).shouldPoll) {
              startStatusPolling(quote.paymentAttemptId);
            }
          });
          return;
        }

        if (hasApiErrorCode(err, 'USDC_INVALID_ATTEMPT')) {
          quoteRequestIdRef.current += 1;
          stopStatusPolling();
          clearPaymentRecovery();
          setQuote(null);
          setQuoteError(null);
          setClaimResult(null);
          setWalletPayResult(null);
          walletPayResultRef.current = null;
          setWalletPayError(
            'This payment attempt or quote is no longer valid. Request a new quote to continue.',
          );
          return;
        }
      }

      // Ambiguous failure after the pay request may already have been accepted server-side.
      if (isAmbiguousPayFailure(err)) {
        const localUnknown: UsdcWalletPayResult = {
          invoiceId: invoice.id,
          paymentAttemptId: quote.paymentAttemptId,
          status: 'needs_review',
          paid: false,
          accepted: true,
          reserved: true,
          isExecutor: false,
          phase: 'unknown',
          chainId: quote.chainId,
          transactionHash: null,
          reviewReason: null,
        };
        setWalletPayResult(localUnknown);
        walletPayResultRef.current = localUnknown;
        enterPaymentRecovery('pay_ambiguous', quote.paymentAttemptId, PAY_AMBIGUOUS_MESSAGE);
        return;
      }

      setWalletPayError(
        friendlyUsdcError(
          err,
          'Could not start wallet payment. Confirm your authenticator code and try again.',
        ),
      );
    } finally {
      if (isMountedRef.current) setWalletPayLoading(false);
    }
  }, [
    applyWalletPayResult,
    clearPaymentRecovery,
    enterPaymentRecovery,
    fetchPaymentStatus,
    getToken,
    invoice.id,
    onChange,
    quote,
    quoteLoading,
    startStatusPolling,
    stopStatusPolling,
    walletPayLoading,
  ]);

  const handleCheckStatus = useCallback(async () => {
    const attemptId =
      quote?.paymentAttemptId ??
      paymentRecoveryRef.current?.paymentAttemptId ??
      walletPayResultRef.current?.paymentAttemptId;
    if (!attemptId) return;
    setWalletPayError(null);
    const data = await fetchPaymentStatus(attemptId, { showSpinner: true });
    if (data && walletPayStatusDisplay(data).shouldPoll) {
      startStatusPolling(attemptId);
    }
  }, [fetchPaymentStatus, quote, startStatusPolling]);

  const handleClaim = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setTxHashTouched(true);
      if (!quote || quoteLoading || !isValidTxHash(txHash)) return;

      setClaimLoading(true);
      setClaimError(null);
      setClaimResult(null);
      setWalletPayError(null);
      try {
        const data = await createUsdcClaimAuth(
          getToken,
          invoice.id,
          quote.paymentAttemptId,
          txHash.trim(),
        );
        setClaimResult(data);
        // Refresh invoice list after claim; only claimResult.paid drives settlement copy.
        void onChange();
      } catch (err: unknown) {
        if (isApiError(err) && err.statusCode === 409) {
          if (hasApiErrorCode(err, 'USDC_INVOICE_NOT_PAYABLE')) {
            // The invoice is no longer payable (paid, finalized, or fully covered).
            // Invalidate the stale quote and await a server-side invoice refresh before allowing
            // any further interaction.
            quoteRequestIdRef.current += 1;
            stopStatusPolling();
            setQuote(null);
            setQuoteError(null);
            setClaimResult(null);
            setClaimError(null);
            setWalletPayResult(null);
            setTxHash('');
            setTxHashTouched(false);
            setInvoiceRefreshPhase('pending');

            try {
              const refreshed = await onChange();
              if (!isMountedRef.current) return;
              setInvoiceRefreshPhase(refreshed ? 'success' : 'error');
            } catch {
              if (!isMountedRef.current) return;
              setInvoiceRefreshPhase('error');
            }
            return;
          }

          if (hasApiErrorCode(err, 'USDC_PAYMENT_IN_PROGRESS', 'USDC_WALLET_PAYMENT_RESERVED')) {
            setClaimError(
              'A USDC payment is already in progress for this invoice. Wait for it to complete, then refresh the quote.',
            );
            void fetchPaymentStatus(quote.paymentAttemptId, { showSpinner: true }).then(
              (status) => {
                if (status && walletPayStatusDisplay(status).shouldPoll) {
                  startStatusPolling(quote.paymentAttemptId);
                }
              },
            );
            return;
          }

          if (hasApiErrorCode(err, 'USDC_INVALID_ATTEMPT')) {
            quoteRequestIdRef.current += 1;
            stopStatusPolling();
            setQuote(null);
            setQuoteError(null);
            setClaimResult(null);
            setWalletPayResult(null);
            setClaimError(
              'This payment attempt or quote is no longer valid. Request a new quote to continue.',
            );
            return;
          }

          if (hasApiErrorCode(err, 'USDC_WALLET_NOT_ACTIVE')) {
            setClaimError('Your wallet is not active yet. Finish wallet setup and try again.');
            return;
          }

          // Unknown 409: keep the current quote and show a generic conflict message.
          setClaimError(
            friendlyUsdcError(
              err,
              'A conflict occurred while submitting the USDC payment. Please refresh the quote or try again.',
            ),
          );
          return;
        }

        setClaimError(
          friendlyUsdcError(
            err,
            'Could not submit the USDC payment. Check the transaction hash and try again.',
          ),
        );
      } finally {
        setClaimLoading(false);
      }
    },
    [
      fetchPaymentStatus,
      getToken,
      invoice.id,
      onChange,
      quote,
      quoteLoading,
      startStatusPolling,
      stopStatusPolling,
      txHash,
    ],
  );

  const chainOption = quote ? getChainOption(quote.chainId) : getChainOption(selectedChainId);
  const explorerBase = chainOption?.explorer ?? 'https://basescan.org';
  const treasuryExplorerUrl = quote?.treasuryAddress
    ? `${explorerBase}/address/${quote.treasuryAddress}`
    : null;
  const payerExplorerUrl = quote?.expectedPayerAddress
    ? `${explorerBase}/address/${quote.expectedPayerAddress}`
    : null;
  const tokenExplorerUrl = quote?.tokenAddress
    ? `${explorerBase}/token/${quote.tokenAddress}`
    : null;
  const txExplorerUrl =
    isValidTxHash(txHash) && chainOption ? `${explorerBase}/tx/${txHash.trim()}` : null;
  const walletTxExplorerUrl =
    walletPayResult?.transactionHash &&
    isValidTxHash(walletPayResult.transactionHash) &&
    chainOption
      ? `${explorerBase}/tx/${walletPayResult.transactionHash.trim()}`
      : null;

  const claimStatus = claimResult ? claimStatusDisplay(claimResult) : null;
  const walletStatus = walletPayResult ? walletPayStatusDisplay(walletPayResult) : null;
  const recoveryLocked = paymentRecovery !== null;
  const paymentActionsLocked =
    recoveryLocked || walletStatus?.lockActions === true || walletPayLoading;

  const claimFormLocked =
    (claimResult !== null &&
      (!isKnownClaimStatus(claimResult.status) || claimResult.retryable !== true)) ||
    paymentActionsLocked;

  const claimDisabled =
    claimLoading ||
    quoteLoading ||
    !quote ||
    !isValidTxHash(txHash) ||
    claimFormLocked ||
    invoiceRefreshPhase === 'pending' ||
    invoiceRefreshPhase === 'error';

  const payFromWalletDisabled =
    walletPayLoading ||
    quoteLoading ||
    !quote ||
    claimLoading ||
    paymentActionsLocked ||
    expiry.expired ||
    expiry.expiringSoon ||
    invoiceRefreshPhase === 'pending' ||
    invoiceRefreshPhase === 'error';

  const controlsLocked =
    invoiceRefreshPhase === 'pending' ||
    invoiceRefreshPhase === 'error' ||
    walletPayLoading ||
    recoveryLocked ||
    (walletStatus?.lockActions === true && walletPayResult?.paid !== true);

  const settledPaid =
    walletPayResult?.paid === true ||
    (claimResult?.paid === true && claimResult.status === 'succeeded');

  const canCheckStatus = Boolean(
    quote?.paymentAttemptId ||
    paymentRecovery?.paymentAttemptId ||
    walletPayResult?.paymentAttemptId,
  );

  return (
    <div className="rounded-xl border border-brand-border bg-brand-bg/40 p-5">
      <div className="flex items-center gap-2 text-sm font-semibold text-brand-text">
        <Wallet className="h-4 w-4 text-brand-accent" />
        Pay with USDC
      </div>
      <p className="mt-1 text-xs leading-5 text-brand-muted">
        Pay from your SOFA platform wallet using the server quote, or send the exact transfer
        yourself and claim with the transaction hash. Only the quoted payer, token, treasury,
        amount, and chain are accepted — the invoice is paid only after the server confirms
        settlement.
      </p>

      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1.5">
          <label
            htmlFor={`usdc-network-${invoice.id}`}
            className="text-[11px] font-bold uppercase tracking-widest text-brand-muted"
          >
            Network
          </label>
          <select
            id={`usdc-network-${invoice.id}`}
            value={selectedChainId}
            onChange={(event) => setSelectedChainId(Number(event.target.value))}
            disabled={quoteLoading || claimLoading || walletPayLoading || controlsLocked}
            className="w-full rounded-lg border border-brand-border bg-white px-3 py-2 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent disabled:opacity-60"
          >
            {USDC_CHAIN_OPTIONS.map((option) => (
              <option key={option.chainId} value={option.chainId}>
                {option.name}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={() => fetchQuote()}
          disabled={
            quoteLoading || claimLoading || walletPayLoading || invoiceRefreshPhase === 'pending'
          }
          className="inline-flex items-center justify-center gap-1.5 rounded-full border border-brand-border bg-white px-4 py-2 text-xs font-semibold text-brand-text transition-all hover:border-brand-accent hover:bg-brand-surface disabled:opacity-60"
        >
          {quoteLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Refresh quote
        </button>
      </div>

      {quoteError && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800"
        >
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{quoteError}</span>
          </div>
        </div>
      )}

      {invoiceRefreshPhase === 'pending' && (
        <div
          role="status"
          className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800"
        >
          <div className="flex items-start gap-2">
            <Loader2 className="mt-0.5 h-3.5 w-3.5 animate-spin shrink-0" />
            <span>Checking invoice status after payment conflict… Please wait.</span>
          </div>
        </div>
      )}

      {invoiceRefreshPhase === 'success' && (
        <div
          role="status"
          className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800"
        >
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Invoice status refreshed. This invoice is no longer payable (it may have been paid or
              finalized). The previous quote is no longer valid. Select a network and click Refresh
              quote to request a new quote.
            </span>
          </div>
        </div>
      )}

      {invoiceRefreshPhase === 'error' && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800"
        >
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Could not confirm invoice status after payment conflict. Close this panel and reopen
              USDC payment, or refresh the page.
            </span>
          </div>
        </div>
      )}

      {quote && !quoteError && (
        <div className="mt-4 space-y-4 rounded-xl border border-brand-border bg-white p-4 shadow-sm">
          <div className="flex items-start gap-2 rounded-lg border border-brand-border/80 bg-brand-bg/50 px-3 py-2 text-[11px] leading-5 text-brand-muted">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-accent" />
            <span>
              Quote facts below are set by the server. The client cannot change amount, token,
              chain, payer, or treasury. Paying from wallet only sends the quote id after
              authenticator confirmation.
            </span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">
                Amount (USD)
              </p>
              <p className="mt-1 text-lg font-semibold text-brand-text">{quote.amountUsd || '—'}</p>
            </div>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">
                Amount (USDC)
              </p>
              <div className="mt-1 flex items-center gap-2">
                <p className="text-lg font-semibold text-brand-text">{formattedUsdcAmount}</p>
                {formattedUsdcAmount && (
                  <CopyButton text={formattedUsdcAmount.replace(' USDC', '')} className="h-7 w-7" />
                )}
              </div>
              <p className="text-[10px] text-brand-muted">
                Exact base units: {quote.amountBaseUnits} · {quote.tokenDecimals} decimals
              </p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">
                Network / chain
              </p>
              <p className="mt-1 text-xs text-brand-text">
                {chainOption?.name ?? `Chain ${quote.chainId}`}
                <span className="text-brand-muted"> · ID {quote.chainId}</span>
              </p>
            </div>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">
                Required confirmations
              </p>
              <p className="mt-1 text-xs text-brand-text">{quote.requiredConfirmations}</p>
            </div>
          </div>

          <div>
            <p className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">
              USDC token contract
            </p>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded-lg bg-brand-bg px-3 py-2 font-mono text-xs text-brand-text">
                {quote.tokenAddress}
              </code>
              <CopyButton text={quote.tokenAddress} className="h-8 w-8 shrink-0" />
            </div>
            <p className="mt-1 text-[10px] text-brand-muted">
              Only this token contract is accepted. Same-name tokens on other contracts will not
              settle the invoice.
            </p>
            {tokenExplorerUrl && (
              <a
                href={tokenExplorerUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-xs text-brand-accent hover:underline"
              >
                View token on explorer <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>

          <div>
            <p className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">
              Required sender (SOFA wallet)
            </p>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded-lg bg-brand-bg px-3 py-2 font-mono text-xs text-brand-text">
                {quote.expectedPayerAddress}
              </code>
              <CopyButton text={quote.expectedPayerAddress} className="h-8 w-8 shrink-0" />
            </div>
            <p className="mt-1 text-[10px] text-brand-muted">
              Payment must come from this active platform wallet. Any other sender will not
              auto-settle.
            </p>
            {payerExplorerUrl && (
              <a
                href={payerExplorerUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-xs text-brand-accent hover:underline"
              >
                View sender on explorer <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>

          <div>
            <p className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">
              Recipient (treasury)
            </p>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded-lg bg-brand-bg px-3 py-2 font-mono text-xs text-brand-text">
                {quote.treasuryAddress}
              </code>
              <CopyButton text={quote.treasuryAddress} className="h-8 w-8 shrink-0" />
            </div>
            {treasuryExplorerUrl && (
              <a
                href={treasuryExplorerUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-xs text-brand-accent hover:underline"
              >
                View on explorer <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">
                Quote expires
              </p>
              <p className="mt-1 text-xs text-brand-text">{formatExpiry(quote.quoteExpiresAt)}</p>
              {expiry.expired && (
                <p className="mt-1 flex items-start gap-1.5 text-[11px] font-medium text-red-700">
                  <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                  This quote has expired. Refresh the quote before paying.
                </p>
              )}
              {!expiry.expired && expiry.expiringSoon && (
                <p className="mt-1 flex items-start gap-1.5 text-[11px] font-medium text-amber-800">
                  <Clock className="mt-0.5 h-3 w-3 shrink-0" />
                  Expires within 5 minutes — wallet pay is blocked until you refresh the quote.
                </p>
              )}
            </div>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">
                Quote attempt
              </p>
              <p className="mt-1 break-all font-mono text-[10px] text-brand-muted">
                {quote.paymentAttemptId}
              </p>
            </div>
          </div>

          {/* Primary: pay from SOFA wallet (user-triggered only). */}
          <div className="space-y-3 border-t border-brand-border pt-4">
            <div>
              <p className="text-xs font-semibold text-brand-text">Pay from SOFA wallet</p>
              <p className="mt-1 text-[11px] leading-5 text-brand-muted">
                Starts a server-side transfer from your platform wallet using this quote only.
                Requires authenticator confirmation. Does not mark the invoice paid until settlement
                is confirmed.
              </p>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <button
                type="button"
                onClick={() => void handlePayFromWallet()}
                disabled={payFromWalletDisabled}
                className="inline-flex items-center justify-center gap-1.5 rounded-full bg-brand-text px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-all hover:bg-brand-text/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {walletPayLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Wallet className="h-4 w-4" />
                )}
                {walletPayLoading ? 'Submitting…' : 'Pay from wallet'}
              </button>

              <button
                type="button"
                onClick={() => void handleCheckStatus()}
                disabled={
                  !canCheckStatus ||
                  statusRefreshing ||
                  quoteLoading ||
                  walletPayLoading ||
                  invoiceRefreshPhase === 'pending'
                }
                className="inline-flex items-center justify-center gap-1.5 rounded-full border border-brand-border bg-white px-4 py-2.5 text-xs font-semibold text-brand-text transition-all hover:border-brand-accent hover:bg-brand-surface disabled:opacity-60"
              >
                {statusRefreshing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Check status
              </button>
            </div>

            {paymentRecovery && (
              <div
                role="alert"
                className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
              >
                <div className="flex items-start gap-2">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <div className="min-w-0 space-y-1">
                    <p className="font-semibold">
                      {paymentRecovery.kind === 'pay_ambiguous'
                        ? 'Payment result unconfirmed'
                        : 'Status unconfirmed'}
                    </p>
                    <p>{paymentRecovery.message}</p>
                  </div>
                </div>
              </div>
            )}

            {walletPayError && !paymentRecovery && (
              <div
                role="alert"
                className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800"
              >
                <div className="flex items-start gap-2">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{walletPayError}</span>
                </div>
              </div>
            )}

            {walletStatus && !walletPayError && !paymentRecovery && (
              <div
                role="status"
                className={`rounded-lg border p-3 text-xs ${
                  walletStatus.tone === 'green'
                    ? 'border-green-200 bg-green-50 text-green-800'
                    : walletStatus.tone === 'amber'
                      ? 'border-amber-200 bg-amber-50 text-amber-800'
                      : walletStatus.tone === 'red'
                        ? 'border-red-200 bg-red-50 text-red-800'
                        : 'border-blue-200 bg-blue-50 text-blue-800'
                }`}
              >
                <div className="flex items-start gap-2">
                  {walletStatus.tone === 'green' ? (
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  ) : walletPayLoading || statusRefreshing ? (
                    <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
                  ) : (
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  )}
                  <div className="min-w-0 space-y-1">
                    <p className="font-semibold">{walletStatus.title}</p>
                    <p>{walletStatus.message}</p>
                    {walletPayResult?.transactionHash && (
                      <p className="break-all font-mono text-[10px] opacity-90">
                        Tx: {walletPayResult.transactionHash}
                      </p>
                    )}
                    {walletTxExplorerUrl && (
                      <a
                        href={walletTxExplorerUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline"
                      >
                        View transaction <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                    {statusPollNote && (
                      <p className="pt-1 text-[11px] opacity-90">{statusPollNote}</p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {settledPaid && (
              <p className="text-[11px] font-medium text-green-800">
                Invoice settlement confirmed by the server. Further payments are disabled for this
                quote.
              </p>
            )}
          </div>

          {/* Secondary: manual external send + claim (preserved). */}
          <form
            onSubmit={handleClaim}
            className="space-y-3 border-t border-brand-border pt-4"
            aria-disabled={claimFormLocked || settledPaid}
          >
            <div>
              <p className="text-xs font-semibold text-brand-text">Or claim a manual transfer</p>
              <p className="mt-1 text-[11px] leading-5 text-brand-muted">
                If you already sent the exact USDC transfer from the required sender to the
                treasury, paste the transaction hash. Claiming does not invent payment — the server
                verifies the receipt.
              </p>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor={`usdc-tx-hash-${invoice.id}`}
                className="text-[11px] font-bold uppercase tracking-widest text-brand-muted"
              >
                Transaction hash
              </label>
              <input
                id={`usdc-tx-hash-${invoice.id}`}
                type="text"
                value={txHash}
                onChange={(event) => setTxHash(event.target.value)}
                onBlur={() => setTxHashTouched(true)}
                placeholder="0x..."
                disabled={claimLoading || claimFormLocked || settledPaid}
                className="w-full rounded-lg border border-brand-border px-3 py-2 font-mono text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent placeholder:text-brand-muted disabled:opacity-60"
              />
              {txHashError && <p className="text-xs text-red-600">{txHashError}</p>}
            </div>

            {txExplorerUrl && (
              <a
                href={txExplorerUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-brand-accent hover:underline"
              >
                Preview transaction on explorer <ExternalLink className="h-3 w-3" />
              </a>
            )}

            <button
              type="submit"
              disabled={claimDisabled || settledPaid}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-full border border-brand-border bg-white px-5 py-2.5 text-sm font-semibold text-brand-text shadow-sm transition-all hover:border-brand-accent hover:bg-brand-surface disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
            >
              {claimLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              {claimLoading ? 'Submitting…' : 'I have sent USDC — Claim payment'}
            </button>
          </form>
        </div>
      )}

      {claimError && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800"
        >
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{claimError}</span>
          </div>
        </div>
      )}

      {claimStatus && !claimError && (
        <div
          role="status"
          className={`mt-4 rounded-lg border p-3 text-xs ${
            claimStatus.tone === 'green'
              ? 'border-green-200 bg-green-50 text-green-800'
              : claimStatus.tone === 'amber'
                ? 'border-amber-200 bg-amber-50 text-amber-800'
                : claimStatus.tone === 'red'
                  ? 'border-red-200 bg-red-50 text-red-800'
                  : 'border-blue-200 bg-blue-50 text-blue-800'
          }`}
        >
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{claimStatus.message}</span>
          </div>
        </div>
      )}
    </div>
  );
}
