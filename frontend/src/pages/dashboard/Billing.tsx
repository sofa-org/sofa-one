import { useCallback, useEffect, useMemo, useState } from 'react';
import { useUser } from '@openfort/react';
import {
  Activity,
  AlertCircle,
  ArrowRight,
  Check,
  CreditCard,
  Loader2,
  Receipt,
  RotateCcw,
  Wallet,
  Zap,
} from 'lucide-react';
import { DashboardPage, DashboardCard } from './components/DashboardPage';
import {
  getApiErrorMessage,
  getBillingPlansAuth,
  getBillingSummaryAuth,
  listBillingInvoicesAuth,
  type BillingInvoice,
  type BillingPlanResponse,
  type BillingSummary,
  type BillingTierBreakdown,
} from '@/lib/api';

const INVOICE_PAGE_SIZE = 20;

function isIntegerString(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

function isDecimalString(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value.trim());
}

function formatCount(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const trimmed = value.trim();
  if (!isIntegerString(trimmed)) return trimmed;
  try {
    return BigInt(trimmed).toLocaleString('en-US');
  } catch {
    return trimmed;
  }
}

function formatAmount(value: string | null | undefined, currency?: string): string {
  if (value === null || value === undefined || value === '') return '—';
  const trimmed = value.trim();
  if (!isDecimalString(trimmed)) return trimmed;
  if (!currency) return trimmed;
  return `${currency} ${trimmed}`;
}

function formatPeriodLabel(period: string): string {
  if (!/^\d{4}-\d{2}$/.test(period)) return period;
  const [year, month] = period.split('-');
  const date = new Date(Number(year), Number(month) - 1, 1);
  if (Number.isNaN(date.getTime())) return period;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
}

function formatInvoiceStatus(status: string): string {
  switch (status) {
    case 'paid':
      return 'Paid';
    case 'open':
      return 'Open';
    case 'void':
      return 'Void';
    case 'uncollectible':
      return 'Uncollectible';
    default:
      return status;
  }
}

function statusTone(status: string): string {
  switch (status) {
    case 'paid':
      return 'bg-green-100 text-green-700';
    case 'open':
      return 'bg-amber-100 text-amber-700';
    case 'void':
    case 'uncollectible':
      return 'bg-red-100 text-red-700';
    default:
      return 'bg-gray-100 text-gray-700';
  }
}

function getCurrentUtcMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function PageError({
  message,
  onRetry,
  retrying,
}: {
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800 shadow-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <AlertCircle className="h-5 w-5 shrink-0 text-red-500" />
        <span>{message}</span>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="inline-flex items-center justify-center gap-1.5 rounded-full border border-red-200 bg-white px-4 py-1.5 text-xs font-semibold text-red-700 transition-all hover:border-red-300 hover:bg-red-100 disabled:opacity-50"
        >
          {retrying ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RotateCcw className="h-3.5 w-3.5" />
          )}
          Retry
        </button>
      )}
    </div>
  );
}

function InlineSpinner() {
  return (
    <div className="flex items-center justify-center py-12">
      <Loader2 className="h-8 w-8 animate-spin text-brand-accent" />
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  subtext,
  tone = 'muted',
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  subtext: string;
  tone?: 'muted' | 'amber' | 'red';
}) {
  const toneClasses =
    tone === 'red'
      ? 'text-red-700'
      : tone === 'amber'
        ? 'text-amber-700'
        : 'text-brand-muted';
  return (
    <div className="rounded-xl border border-brand-border bg-white p-5 shadow-sm transition-shadow hover:shadow-md">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-bg">
          <Icon className="h-5 w-5 text-brand-accent" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">{label}</p>
          <p className="mt-1 truncate text-2xl font-semibold text-brand-text">{value}</p>
          <p className={`mt-0.5 text-xs ${toneClasses}`}>{subtext}</p>
        </div>
      </div>
    </div>
  );
}

export default function BillingPage() {
  const { getAccessToken, isAuthenticated, isLoading: authLoading } = useUser();
  const getToken = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) {
      throw new Error('Openfort session is not ready. Refresh and sign in again.');
    }
    return token;
  }, [getAccessToken]);

  const [period, setPeriod] = useState<string>(getCurrentUtcMonth);

  const [plans, setPlans] = useState<BillingPlanResponse | null>(null);
  const [plansLoading, setPlansLoading] = useState(true);
  const [plansError, setPlansError] = useState<string | null>(null);
  const [plansRetryNonce, setPlansRetryNonce] = useState(0);

  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryRetryNonce, setSummaryRetryNonce] = useState(0);

  const [invoices, setInvoices] = useState<BillingInvoice[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(true);
  const [invoicesError, setInvoicesError] = useState<string | null>(null);
  const [invoicesRetryNonce, setInvoicesRetryNonce] = useState(0);

  const currentPlan = useMemo(() => {
    if (!plans) return null;
    return plans.plans.find((plan) => plan.id === plans.currentPlanId) ?? null;
  }, [plans]);

  const loadPlans = useCallback(
    async (signal?: AbortSignal) => {
      setPlansLoading(true);
      setPlansError(null);
      try {
        const data = await getBillingPlansAuth(getToken, signal);
        if (!signal?.aborted) setPlans(data);
      } catch (err: unknown) {
        if (!signal?.aborted) setPlansError(getApiErrorMessage(err));
      } finally {
        if (!signal?.aborted) setPlansLoading(false);
      }
    },
    [getToken],
  );

  const loadSummary = useCallback(
    async (signal?: AbortSignal) => {
      setSummaryLoading(true);
      setSummaryError(null);
      try {
        const data = await getBillingSummaryAuth(getToken, period, signal);
        if (!signal?.aborted) setSummary(data);
      } catch (err: unknown) {
        if (!signal?.aborted) setSummaryError(getApiErrorMessage(err));
      } finally {
        if (!signal?.aborted) setSummaryLoading(false);
      }
    },
    [getToken, period],
  );

  const loadInvoices = useCallback(
    async (signal?: AbortSignal) => {
      setInvoicesLoading(true);
      setInvoicesError(null);
      try {
        const data = await listBillingInvoicesAuth(getToken, { limit: INVOICE_PAGE_SIZE }, signal);
        if (!signal?.aborted) setInvoices(data.items);
      } catch (err: unknown) {
        if (!signal?.aborted) setInvoicesError(getApiErrorMessage(err));
      } finally {
        if (!signal?.aborted) setInvoicesLoading(false);
      }
    },
    [getToken],
  );

  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) {
      setPlansLoading(false);
      setSummaryLoading(false);
      setInvoicesLoading(false);
      return;
    }

    const controller = new AbortController();
    void loadPlans(controller.signal);
    void loadSummary(controller.signal);
    void loadInvoices(controller.signal);
    return () => controller.abort();
  }, [authLoading, isAuthenticated, loadPlans, loadSummary, loadInvoices, plansRetryNonce, summaryRetryNonce, invoicesRetryNonce]);

  const isLoading = plansLoading || summaryLoading;
  const anyError = plansError || summaryError;

  return (
    <DashboardPage
      title="Billing"
      description="Review your plan, monthly usage, and invoices."
    >
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 shadow-sm">
        <p className="font-medium">Usage preview only</p>
        <p className="mt-1 text-amber-700">
          Payments and automatic plan upgrades are not enabled yet. This page shows your current
          usage and estimated charges for the selected billing period.
        </p>
      </div>

      {anyError && !isLoading && (
        <PageError
          message={plansError ?? summaryError ?? 'Could not load billing data.'}
          onRetry={() => {
            if (plansError) setPlansRetryNonce((n) => n + 1);
            if (summaryError) setSummaryRetryNonce((n) => n + 1);
          }}
          retrying={plansLoading || summaryLoading}
        />
      )}

      {invoicesError && (
        <PageError
          message={invoicesError}
          onRetry={() => setInvoicesRetryNonce((n) => n + 1)}
          retrying={invoicesLoading}
        />
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Current plan */}
        <DashboardCard
          title="Current Plan"
          description="Your active plan and included allowances."
          className="lg:col-span-1"
        >
          {plansLoading ? (
            <InlineSpinner />
          ) : !currentPlan ? (
            <div className="py-8 text-center">
              <p className="text-brand-muted">No plan information available.</p>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand-accent/10">
                    <CreditCard className="h-6 w-6 text-brand-accent" />
                  </div>
                  <div>
                    <p className="text-lg font-semibold text-brand-text">{currentPlan.name}</p>
                    <p className="text-xs text-brand-muted">{currentPlan.billingPeriod}</p>
                  </div>
                </div>
                <span className="shrink-0 text-lg font-semibold text-brand-text">
                  {formatAmount(currentPlan.basePrice, currentPlan.currency)}
                </span>
              </div>
              <p className="text-sm leading-6 text-brand-muted">{currentPlan.description}</p>
              {currentPlan.features.length > 0 && (
                <ul className="space-y-2">
                  {currentPlan.features.map((feature, index) => (
                    <li key={index} className="flex items-start gap-2 text-sm text-brand-text">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </DashboardCard>

        {/* Usage summary */}
        <DashboardCard
          title="Usage This Period"
          description="Track outbound volume, API calls, and active wallets."
          className="lg:col-span-2"
        >
          <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">
              Billing period (UTC)
            </label>
            <input
              type="month"
              value={period}
              onChange={(event) => setPeriod(event.target.value)}
              className="w-full rounded-lg border border-brand-border px-3 py-2 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent sm:w-auto"
            />
          </div>

          {summaryLoading ? (
            <InlineSpinner />
          ) : !summary ? (
            <div className="py-8 text-center">
              <p className="text-brand-muted">No usage data for this period.</p>
            </div>
          ) : (
            <div className="space-y-5">
              <p className="text-sm text-brand-muted">
                Showing usage for{' '}
                <span className="font-semibold text-brand-text">{formatPeriodLabel(summary.period)}</span>
                . Allowances reset at the start of each UTC month.
              </p>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <MetricCard
                  icon={Zap}
                  label="Outbound volume"
                  value={formatCount(summary.outboundVolume)}
                  subtext={`${formatCount(summary.outboundFreeAllowance)} included`}
                  tone={
                    (summary.outboundOverage || '0') !== '0'
                      ? 'amber'
                      : 'muted'
                  }
                />
                <MetricCard
                  icon={Activity}
                  label="API calls"
                  value={formatCount(summary.apiCalls)}
                  subtext={`${formatCount(summary.apiCallsFreeAllowance)} included`}
                  tone={
                    BigInt(summary.apiCalls || '0') > BigInt(summary.apiCallsFreeAllowance || '0')
                      ? 'amber'
                      : 'muted'
                  }
                />
                <MetricCard
                  icon={Wallet}
                  label="Active wallets"
                  value={formatCount(summary.activeWallets)}
                  subtext={`${formatCount(summary.activeWalletsFreeAllowance)} included`}
                  tone={
                    BigInt(summary.activeWallets || '0') >
                    BigInt(summary.activeWalletsFreeAllowance || '0')
                      ? 'amber'
                      : 'muted'
                  }
                />
              </div>
            </div>
          )}
        </DashboardCard>
      </div>

      {/* Estimated cost */}
      <DashboardCard
        title="Estimated Cost"
        description="Breakdown of base cost, overages, and tiered usage."
      >
        {summaryLoading ? (
          <InlineSpinner />
        ) : !summary ? (
          <div className="py-8 text-center">
            <p className="text-brand-muted">No cost estimate available.</p>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-xl border border-brand-border bg-brand-bg/60 p-4">
                <p className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">Base cost</p>
                <p className="mt-1 text-xl font-semibold text-brand-text">
                  {formatAmount(summary.estimatedBaseCost, summary.currency)}
                </p>
              </div>
              <div className="rounded-xl border border-brand-border bg-brand-bg/60 p-4">
                <p className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">Overage</p>
                <p
                  className={`mt-1 text-xl font-semibold ${
                    (summary.outboundOverage || '0') !== '0'
                      ? 'text-amber-700'
                      : 'text-brand-text'
                  }`}
                >
                  {formatAmount(summary.estimatedOverageCost, summary.currency)}
                </p>
              </div>
              <div className="rounded-xl border border-brand-border bg-brand-bg/60 p-4">
                <p className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">Estimated total</p>
                <p className="mt-1 text-xl font-semibold text-brand-text">
                  {formatAmount(summary.estimatedTotal, summary.currency)}
                </p>
              </div>
            </div>

            {summary.tierBreakdown.length > 0 && (
              <div>
                <h3 className="mb-3 text-sm font-semibold text-brand-text">Tier breakdown</h3>
                <div className="overflow-x-auto rounded-xl border border-brand-border">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-brand-bg">
                      <tr className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">
                        <th className="px-4 py-3">Tier</th>
                        <th className="px-4 py-3">Range</th>
                        <th className="px-4 py-3 text-right">Quantity</th>
                        <th className="px-4 py-3 text-right">Rate</th>
                        <th className="px-4 py-3 text-right">Cost</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-brand-border">
                      {summary.tierBreakdown.map((tier, index) => (
                        <TierRow key={index} tier={tier} currency={summary.currency} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {summary.overageRate && summary.overageRate !== '0' && (
              <p className="text-xs text-brand-muted">
                Overage rate: {formatAmount(summary.overageRate, summary.currency)} per
                {summary.overageUnit || ' unit'} beyond the free allowance.
              </p>
            )}
          </div>
        )}
      </DashboardCard>

      {/* Invoices */}
      <DashboardCard title="Invoices" description="Historical billing statements.">
        {invoicesLoading ? (
          <InlineSpinner />
        ) : invoicesError ? (
          <div className="py-8 text-center">
            <p className="text-brand-muted">Could not load invoices.</p>
          </div>
        ) : invoices.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-bg">
              <Receipt className="h-6 w-6 text-brand-muted" />
            </div>
            <p className="mt-4 text-base font-semibold text-brand-text">No invoices yet</p>
            <p className="mt-1 max-w-sm text-sm text-brand-muted">
              Invoices will appear here once billing statements are generated for your account.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-brand-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-brand-bg">
                <tr className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">
                  <th className="px-4 py-3">Period</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3 text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-brand-border">
                {invoices.map((invoice) => (
                  <tr key={invoice.id} className="transition-colors hover:bg-brand-surface">
                    <td className="px-4 py-3 font-medium text-brand-text">
                      {formatPeriodLabel(invoice.period)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${statusTone(invoice.status)}`}
                      >
                        {formatInvoiceStatus(invoice.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-brand-text">
                      {formatAmount(invoice.amount, invoice.currency)}
                    </td>
                    <td className="px-4 py-3 text-brand-muted">
                      {new Date(invoice.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {invoice.pdfUrl ? (
                        <a
                          href={invoice.pdfUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs font-semibold text-brand-accent hover:underline"
                        >
                          View <ArrowRight className="h-3 w-3" />
                        </a>
                      ) : (
                        <span className="text-xs text-brand-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DashboardCard>
    </DashboardPage>
  );
}

function TierRow({
  tier,
  currency,
}: {
  tier: BillingTierBreakdown;
  currency: string;
}) {
  const range = [tier.from, tier.to]
    .map((value) => formatCount(value))
    .join(' – ');
  return (
    <tr className="transition-colors hover:bg-brand-surface">
      <td className="px-4 py-3 font-medium text-brand-text">{tier.tier}</td>
      <td className="px-4 py-3 text-brand-muted">{range}</td>
      <td className="px-4 py-3 text-right font-mono text-brand-text">{formatCount(tier.quantity)}</td>
      <td className="px-4 py-3 text-right font-mono text-brand-muted">
        {formatAmount(tier.rate, currency)}
      </td>
      <td className="px-4 py-3 text-right font-mono text-brand-text">
        {formatAmount(tier.cost, currency)}
      </td>
    </tr>
  );
}
