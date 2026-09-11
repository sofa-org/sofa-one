import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, ExternalLink, Loader2, RefreshCw, Wallet } from 'lucide-react';
import { CopyButton } from '@/components/CopyButton';
import {
  createUsdcClaimAuth,
  createUsdcQuoteAuth,
  hasApiErrorCode,
  isApiError,
  type BillingInvoice,
  type UsdcClaimResponse,
  type UsdcClaimStatus,
  type UsdcQuoteResponse,
} from '@/lib/api';

const USDC_CHAIN_OPTIONS: Array<{ chainId: number; name: string; explorer: string }> = [
  { chainId: 8453, name: 'Base Mainnet', explorer: 'https://basescan.org' },
  { chainId: 84532, name: 'Base Sepolia', explorer: 'https://sepolia.basescan.org' },
  { chainId: 1, name: 'Ethereum Mainnet', explorer: 'https://etherscan.io' },
  { chainId: 11155111, name: 'Ethereum Sepolia', explorer: 'https://sepolia.etherscan.io' },
];

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

function friendlyUsdcError(error: unknown, fallback: string): string {
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
    if (error.code === 'USDC_WALLET_NOT_ACTIVE') {
      return 'Your wallet is not active yet. Finish wallet setup and try again.';
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

  const [invoiceRefreshPhase, setInvoiceRefreshPhase] = useState<
    'idle' | 'pending' | 'success' | 'error'
  >('idle');

  const quoteRequestIdRef = useRef(0);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
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

  const fetchQuote = useCallback(
    async (signal?: AbortSignal) => {
      const requestId = (quoteRequestIdRef.current += 1);

      // Invalidate the previous quote and any claim state before the new request.
      setQuote(null);
      setQuoteError(null);
      setClaimResult(null);
      setClaimError(null);
      setTxHash('');
      setTxHashTouched(false);
      setInvoiceRefreshPhase('idle');
      setQuoteLoading(true);

      try {
        const data = await createUsdcQuoteAuth(getToken, invoice.id, selectedChainId, signal);
        if (signal?.aborted) return;
        if (requestId !== quoteRequestIdRef.current) return; // stale response
        setQuote(data);
        setSelectedChainId(data.chainId);
      } catch (err: unknown) {
        if (signal?.aborted) return;
        if (requestId !== quoteRequestIdRef.current) return;
        setQuoteError(
          friendlyUsdcError(
            err,
            'Could not get a USDC quote. Check the selected network and try again.',
          ),
        );
      } finally {
        if (!signal?.aborted && requestId === quoteRequestIdRef.current) {
          setQuoteLoading(false);
        }
      }
    },
    [getToken, invoice.id, selectedChainId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void fetchQuote(controller.signal);
    return () => controller.abort();
  }, [fetchQuote]);

  const handleClaim = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setTxHashTouched(true);
      if (!quote || quoteLoading || !isValidTxHash(txHash)) return;

      setClaimLoading(true);
      setClaimError(null);
      setClaimResult(null);
      try {
        const data = await createUsdcClaimAuth(
          getToken,
          invoice.id,
          quote.paymentAttemptId,
          txHash.trim(),
        );
        setClaimResult(data);
        void onChange();
      } catch (err: unknown) {
        if (isApiError(err) && err.statusCode === 409) {
          if (hasApiErrorCode(err, 'USDC_INVOICE_NOT_PAYABLE')) {
            // The invoice is no longer payable (paid, finalized, or fully covered).
            // Invalidate the stale quote and await a server-side invoice refresh before allowing
            // any further interaction.
            quoteRequestIdRef.current += 1;
            setQuote(null);
            setQuoteError(null);
            setClaimResult(null);
            setClaimError(null);
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

          if (hasApiErrorCode(err, 'USDC_PAYMENT_IN_PROGRESS')) {
            setClaimError(
              'A USDC payment is already in progress for this invoice. Wait for it to complete, then refresh the quote.',
            );
            return;
          }

          if (hasApiErrorCode(err, 'USDC_INVALID_ATTEMPT')) {
            quoteRequestIdRef.current += 1;
            setQuote(null);
            setQuoteError(null);
            setClaimResult(null);
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
    [getToken, invoice.id, onChange, quote, quoteLoading, txHash],
  );

  const chainOption = quote ? getChainOption(quote.chainId) : getChainOption(selectedChainId);
  const explorerBase = chainOption?.explorer ?? 'https://basescan.org';
  const treasuryExplorerUrl = quote?.treasuryAddress
    ? `${explorerBase}/address/${quote.treasuryAddress}`
    : null;
  const txExplorerUrl =
    isValidTxHash(txHash) && chainOption ? `${explorerBase}/tx/${txHash.trim()}` : null;

  const status = claimResult ? claimStatusDisplay(claimResult) : null;
  const claimFormLocked =
    claimResult !== null &&
    (!isKnownClaimStatus(claimResult.status) || claimResult.retryable !== true);
  const claimDisabled =
    claimLoading || quoteLoading || !quote || !isValidTxHash(txHash) || claimFormLocked;
  const controlsLocked = invoiceRefreshPhase === 'pending' || invoiceRefreshPhase === 'error';

  return (
    <div className="rounded-xl border border-brand-border bg-brand-bg/40 p-5">
      <div className="flex items-center gap-2 text-sm font-semibold text-brand-text">
        <Wallet className="h-4 w-4 text-brand-accent" />
        Pay with USDC
      </div>
      <p className="mt-1 text-xs leading-5 text-brand-muted">
        Send USDC from your own wallet, then paste the transaction hash here. The server will verify
        the transfer before marking the invoice paid.
      </p>

      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1.5">
          <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">
            Network
          </label>
          <select
            value={selectedChainId}
            onChange={(event) => setSelectedChainId(Number(event.target.value))}
            disabled={quoteLoading || claimLoading || controlsLocked}
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
          disabled={quoteLoading || claimLoading || controlsLocked}
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
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{quoteError}</span>
          </div>
        </div>
      )}

      {invoiceRefreshPhase === 'pending' && (
        <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
          <div className="flex items-start gap-2">
            <Loader2 className="mt-0.5 h-3.5 w-3.5 animate-spin shrink-0" />
            <span>Checking invoice status after payment conflict… Please wait.</span>
          </div>
        </div>
      )}

      {invoiceRefreshPhase === 'success' && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
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
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">
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
              <p className="text-[10px] text-brand-muted">Base units: {quote.amountBaseUnits}</p>
            </div>
          </div>

          <div>
            <p className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">
              Recipient address
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
            </div>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">
                Required confirmations
              </p>
              <p className="mt-1 text-xs text-brand-text">{quote.requiredConfirmations}</p>
            </div>
          </div>

          <form onSubmit={handleClaim} className="space-y-3 border-t border-brand-border pt-4">
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
                disabled={claimLoading || claimFormLocked}
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
              disabled={claimDisabled}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-full bg-brand-text px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-all hover:bg-brand-text/90 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
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
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{claimError}</span>
          </div>
        </div>
      )}

      {status && !claimError && (
        <div
          className={`mt-4 rounded-lg border p-3 text-xs ${
            status.tone === 'green'
              ? 'border-green-200 bg-green-50 text-green-800'
              : status.tone === 'amber'
                ? 'border-amber-200 bg-amber-50 text-amber-800'
                : status.tone === 'red'
                  ? 'border-red-200 bg-red-50 text-red-800'
                  : 'border-blue-200 bg-blue-50 text-blue-800'
          }`}
        >
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{status.message}</span>
          </div>
        </div>
      )}
    </div>
  );
}
