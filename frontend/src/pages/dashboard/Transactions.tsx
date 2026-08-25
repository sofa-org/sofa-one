import { useCallback, useEffect, useState } from 'react';
import { useUser } from '@openfort/react';
import { AlertCircle, ArrowLeft, ArrowRight, Loader2, RefreshCw, X } from 'lucide-react';
import { DashboardPage, DashboardCard } from './components/DashboardPage';
import { CopyButton } from '@/components/CopyButton';
import {
  listTransactionsAuth,
  listSigningRequestsAuth,
  getTransactionDetailAuth,
  getSigningRequestDetailAuth,
  getApiErrorMessage,
  type TransactionListItem,
  type SigningRequestListItem,
  type TransactionDetail,
  type SigningRequestDetail,
} from '@/lib/api';

const TX_STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'submitting', label: 'Submitting' },
  { value: 'pending', label: 'Pending' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'failed', label: 'Failed' },
  { value: 'unknown', label: 'Unknown' },
] as const;

const SR_STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'submitting', label: 'Submitting' },
  { value: 'signed', label: 'Signed' },
  { value: 'failed', label: 'Failed' },
] as const;

const SR_TYPE_OPTIONS = [
  { value: '', label: 'All types' },
  { value: 'message', label: 'Message' },
  { value: 'typed_data', label: 'Typed Data (EIP-712)' },
] as const;

const CHAIN_OPTIONS = [
  { value: 0, label: 'All chains' },
  { value: 84532, label: 'Base Sepolia' },
  { value: 8453, label: 'Base' },
  { value: 1, label: 'Ethereum' },
  { value: 11155111, label: 'Ethereum Sepolia' },
  { value: 137, label: 'Polygon' },
  { value: 80002, label: 'Polygon Amoy' },
] as const;

const PAGE_SIZE = 20;

type TabValue = 'transactions' | 'signing-requests';

function formatRelativeTime(iso: string | null) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Invalid date';
  const now = Date.now();
  const diff = now - date.getTime();
  const absDiff = Math.abs(diff);
  if (absDiff < 60_000) return 'Just now';
  if (absDiff < 3_600_000) return `${Math.floor(absDiff / 60_000)}m ago`;
  if (absDiff < 86_400_000) return `${Math.floor(absDiff / 3_600_000)}h ago`;
  if (absDiff < 30 * 86_400_000) return `${Math.floor(absDiff / 86_400_000)}d ago`;
  return date.toLocaleDateString();
}

function formatFullDate(iso: string | null) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Invalid date';
  return date.toLocaleString();
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    submitting: 'bg-blue-50 text-blue-700 ring-blue-600/20',
    pending: 'bg-yellow-50 text-yellow-700 ring-yellow-600/20',
    confirmed: 'bg-green-50 text-green-700 ring-green-600/20',
    signed: 'bg-green-50 text-green-700 ring-green-600/20',
    failed: 'bg-red-50 text-red-700 ring-red-600/20',
    unknown: 'bg-gray-50 text-gray-700 ring-gray-600/20',
  };
  return map[status] ?? 'bg-gray-50 text-gray-700 ring-gray-600/20';
}

function chainName(chainId: number | null) {
  if (chainId === null) return '—';
  const found = CHAIN_OPTIONS.find((c) => c.value === chainId);
  return found ? found.label : `Chain ${chainId}`;
}

function truncateAddress(address: string | null) {
  if (!address) return '—';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export default function TransactionsPage() {
  const { getAccessToken, isAuthenticated, isLoading: authLoading } = useUser();
  const getToken = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) throw new Error('Openfort session is not ready. Refresh and sign in again.');
    return token;
  }, [getAccessToken]);

  const [activeTab, setActiveTab] = useState<TabValue>('transactions');

  // Transaction state
  const [txItems, setTxItems] = useState<TransactionListItem[]>([]);
  const [txTotal, setTxTotal] = useState(0);
  const [txPage, setTxPage] = useState(1);
  const [txStatus, setTxStatus] = useState('');
  const [txChainId, setTxChainId] = useState(0);
  const [txLoading, setTxLoading] = useState(true);
  const [txError, setTxError] = useState<string | null>(null);

  // Signing request state
  const [srItems, setSrItems] = useState<SigningRequestListItem[]>([]);
  const [srTotal, setSrTotal] = useState(0);
  const [srPage, setSrPage] = useState(1);
  const [srType, setSrType] = useState('');
  const [srStatus, setSrStatus] = useState('');
  const [srChainId, setSrChainId] = useState(0);
  const [srLoading, setSrLoading] = useState(true);
  const [srError, setSrError] = useState<string | null>(null);

  // Drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerType, setDrawerType] = useState<'transaction' | 'signing-request' | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [drawerData, setDrawerData] = useState<TransactionDetail | SigningRequestDetail | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerError, setDrawerError] = useState<string | null>(null);
  const [drawerRetryNonce, setDrawerRetryNonce] = useState(0);

  const fetchTransactions = useCallback(async () => {
    setTxLoading(true);
    setTxError(null);
    try {
      const params: Record<string, unknown> = { page: txPage, limit: PAGE_SIZE };
      if (txStatus) params.status = txStatus;
      if (txChainId) params.chainId = txChainId;
      const data = await listTransactionsAuth(getToken, params, undefined);
      setTxItems(data.items);
      setTxTotal(data.total);
    } catch (err: unknown) {
      setTxError(getApiErrorMessage(err));
    } finally {
      setTxLoading(false);
    }
  }, [getToken, txPage, txStatus, txChainId]);

  const fetchSigningRequests = useCallback(async () => {
    setSrLoading(true);
    setSrError(null);
    try {
      const params: Record<string, unknown> = { page: srPage, limit: PAGE_SIZE };
      if (srType) params.type = srType;
      if (srStatus) params.status = srStatus;
      if (srChainId) params.chainId = srChainId;
      const data = await listSigningRequestsAuth(getToken, params, undefined);
      setSrItems(data.items);
      setSrTotal(data.total);
    } catch (err: unknown) {
      setSrError(getApiErrorMessage(err));
    } finally {
      setSrLoading(false);
    }
  }, [getToken, srPage, srType, srStatus, srChainId]);

  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) {
      setTxLoading(false);
      setSrLoading(false);
      return;
    }
    if (activeTab === 'transactions') fetchTransactions();
    else fetchSigningRequests();
  }, [authLoading, isAuthenticated, activeTab, fetchTransactions, fetchSigningRequests]);

  const handleTxStatusChange = useCallback((value: string) => {
    setTxPage(1);
    setTxStatus(value);
  }, []);

  const handleTxChainChange = useCallback((value: number) => {
    setTxPage(1);
    setTxChainId(value);
  }, []);

  const handleSrTypeChange = useCallback((value: string) => {
    setSrPage(1);
    setSrType(value);
  }, []);

  const handleSrStatusChange = useCallback((value: string) => {
    setSrPage(1);
    setSrStatus(value);
  }, []);

  const handleSrChainChange = useCallback((value: number) => {
    setSrPage(1);
    setSrChainId(value);
  }, []);

  const openTransactionDrawer = useCallback((id: string) => {
    setDrawerType('transaction');
    setDrawerId(id);
    setDrawerData(null);
    setDrawerError(null);
    setDrawerLoading(true);
    setDrawerOpen(true);
  }, []);

  const openSigningRequestDrawer = useCallback((id: string) => {
    setDrawerType('signing-request');
    setDrawerId(id);
    setDrawerData(null);
    setDrawerError(null);
    setDrawerLoading(true);
    setDrawerOpen(true);
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
  }, []);

  const retryDrawer = useCallback(() => {
    if (!drawerId) return;
    setDrawerData(null);
    setDrawerError(null);
    setDrawerLoading(true);
    setDrawerRetryNonce((nonce) => nonce + 1);
  }, [drawerId]);

  // Fetch detail when drawer opens
  useEffect(() => {
    if (!drawerOpen || !drawerId) return;
    const id = drawerId;

    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      try {
        if (drawerType === 'transaction') {
          const data = await getTransactionDetailAuth(getToken, id, controller.signal);
          if (!cancelled) setDrawerData(data);
        } else if (drawerType === 'signing-request') {
          const data = await getSigningRequestDetailAuth(getToken, id, controller.signal);
          if (!cancelled) setDrawerData(data);
        }
      } catch (err: unknown) {
        if (!cancelled) setDrawerError(getApiErrorMessage(err));
      } finally {
        if (!cancelled) setDrawerLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [drawerOpen, drawerId, drawerType, drawerRetryNonce, getToken]);

  // Lock body scroll when drawer is open
  useEffect(() => {
    if (drawerOpen) {
      const original = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = original;
      };
    }
  }, [drawerOpen]);

  // Close on Escape
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') closeDrawer();
    }
    if (drawerOpen) {
      window.addEventListener('keydown', onKeyDown);
      return () => window.removeEventListener('keydown', onKeyDown);
    }
  }, [drawerOpen, closeDrawer]);

  const txTotalPages = Math.max(1, Math.ceil(txTotal / PAGE_SIZE));
  const srTotalPages = Math.max(1, Math.ceil(srTotal / PAGE_SIZE));

  return (
    <DashboardPage
      title="History"
      description="View transaction and signing request history for your wallet."
    >
      {/* Tab switcher */}
      <div className="mb-6 flex gap-1 rounded-xl bg-brand-surface p-1">
        {(['transactions', 'signing-requests'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === tab
                ? 'bg-white text-brand-text shadow-sm'
                : 'text-brand-muted hover:text-brand-text'
            }`}
          >
            {tab === 'transactions' ? 'Transactions' : 'Signing Requests'}
          </button>
        ))}
      </div>

      {activeTab === 'transactions' ? (
        <TransactionList
          items={txItems}
          total={txTotal}
          page={txPage}
          totalPages={txTotalPages}
          status={txStatus}
          chainId={txChainId}
          loading={txLoading}
          error={txError}
          onStatusChange={handleTxStatusChange}
          onChainChange={handleTxChainChange}
          onPageChange={setTxPage}
          onRefresh={fetchTransactions}
          onRowClick={openTransactionDrawer}
        />
      ) : (
        <SigningRequestList
          items={srItems}
          total={srTotal}
          page={srPage}
          totalPages={srTotalPages}
          type={srType}
          status={srStatus}
          chainId={srChainId}
          loading={srLoading}
          error={srError}
          onTypeChange={handleSrTypeChange}
          onStatusChange={handleSrStatusChange}
          onChainChange={handleSrChainChange}
          onPageChange={setSrPage}
          onRefresh={fetchSigningRequests}
          onRowClick={openSigningRequestDrawer}
        />
      )}

      {/* Slide-over drawer */}
      {drawerOpen && (
        <DetailDrawer
          open={drawerOpen}
          onClose={closeDrawer}
          title={drawerType === 'transaction' ? 'Transaction Details' : 'Signing Request Details'}
        >
          {drawerLoading ? (
            <div className="flex flex-1 items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-brand-muted" />
            </div>
          ) : drawerError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-12 px-4">
              <AlertCircle className="h-8 w-8 text-red-400" />
              <p className="text-center text-sm text-red-600">{drawerError}</p>
              <button
                onClick={retryDrawer}
                className="inline-flex items-center gap-1.5 rounded-lg border border-brand-border bg-white px-3 py-2 text-sm font-medium text-brand-text transition-colors hover:bg-brand-bg"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Retry
              </button>
            </div>
          ) : drawerType === 'transaction' && drawerData ? (
            <TransactionDetailContent data={drawerData as TransactionDetail} />
          ) : drawerType === 'signing-request' && drawerData ? (
            <SigningRequestDetailContent data={drawerData as SigningRequestDetail} />
          ) : null}
        </DetailDrawer>
      )}
    </DashboardPage>
  );
}

// --- Drawer shell ---

interface DetailDrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

function DetailDrawer({ open, onClose, title, children }: DetailDrawerProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (open) {
      const id = requestAnimationFrame(() => setMounted(true));
      return () => cancelAnimationFrame(id);
    } else {
      setMounted(false);
    }
  }, [open]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/40 transition-opacity duration-300 ${
          mounted ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        className={`relative z-10 flex h-full w-full max-w-md flex-col bg-white shadow-2xl transition-transform duration-300 ease-out md:w-[420px] ${
          mounted ? 'translate-x-0' : 'translate-x-full'
        }`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-brand-border px-5 py-4">
          <h2 id="drawer-title" className="text-base font-semibold text-brand-text">
            {title}
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-brand-muted transition-colors hover:bg-brand-bg hover:text-brand-text"
            aria-label="Close drawer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

// --- Detail content components ---

function DetailField({
  label,
  value,
  copyValue,
  mono = false,
}: {
  label: string;
  value: React.ReactNode;
  copyValue?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">{label}</span>
      <div className="flex items-center gap-2">
        <span className={`text-sm text-brand-text ${mono ? 'font-mono' : ''}`}>{value}</span>
        {copyValue && <CopyButton text={copyValue} />}
      </div>
    </div>
  );
}

function TransactionDetailContent({ data }: { data: TransactionDetail }) {
  return (
    <div className="flex flex-col gap-6">
      {/* Status */}
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">Status</span>
        <span
          className={`inline-flex w-fit items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${statusBadge(data.status)}`}
        >
          {data.status}
        </span>
      </div>

      {/* Core fields */}
      <div className="flex flex-col gap-4">
        <DetailField label="Transaction ID" value={data.id} copyValue={data.id} mono />
        <DetailField label="Chain" value={chainName(data.chainId)} />
        <DetailField
          label="Wallet Address"
          value={data.walletAddress}
          copyValue={data.walletAddress}
          mono
        />
        <DetailField
          label="Operation Type"
          value={data.operationType === 'withdraw' ? 'Withdraw' : data.operationType}
        />
        <DetailField
          label="Auth Method"
          value={data.authMethod === 'api_key' ? 'API Key' : 'Dashboard'}
        />
        <DetailField
          label="API Key"
          value={
            data.apiKeyName && data.apiKeyPrefix
              ? `${data.apiKeyPrefix} · ${data.apiKeyName}`
              : data.apiKeyName ?? data.apiKeyPrefix ?? '—'
          }
        />
        {data.idempotencyKey && (
          <DetailField label="Idempotency Key" value={data.idempotencyKey} copyValue={data.idempotencyKey} mono />
        )}
        <DetailField
          label="Transaction Hash"
          value={data.txHash ?? 'Pending'}
          copyValue={data.txHash ?? undefined}
          mono
        />
        {data.failureReason && (
          <DetailField label="Failure Reason" value={data.failureReason} />
        )}
        <DetailField label="Created At" value={formatFullDate(data.createdAt)} />
        <DetailField label="Completed At" value={formatFullDate(data.completedAt)} />
      </div>

      {/* Withdrawal section */}
      {data.withdrawal && (data.withdrawal.to || data.withdrawal.amount || data.withdrawal.token) && (
        <div className="rounded-xl border border-brand-border bg-brand-surface/50 p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-brand-muted">
            Withdrawal Details
          </h3>
          <div className="flex flex-col gap-3">
            {data.withdrawal.to && (
              <DetailField label="To" value={data.withdrawal.to} copyValue={data.withdrawal.to} mono />
            )}
            {data.withdrawal.amount && (
              <DetailField label="Amount" value={data.withdrawal.amount} />
            )}
            {data.withdrawal.token && (
              <DetailField label="Token" value={data.withdrawal.token} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SigningRequestDetailContent({ data }: { data: SigningRequestDetail }) {
  const typeLabel = data.type === 'typed_data' ? 'EIP-712' : data.type === 'message' ? 'Message' : data.type;

  return (
    <div className="flex flex-col gap-6">
      {/* Status & Type */}
      <div className="flex flex-wrap gap-2">
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${statusBadge(data.status)}`}
        >
          {data.status}
        </span>
        <span className="inline-flex items-center rounded-md bg-brand-accent/10 px-2 py-0.5 text-xs font-medium text-brand-accent">
          {typeLabel}
        </span>
      </div>

      {/* Core fields */}
      <div className="flex flex-col gap-4">
        <DetailField label="Request ID" value={data.id} copyValue={data.id} mono />
        <DetailField label="Type" value={typeLabel} />
        <DetailField label="Chain" value={chainName(data.chainId)} />
        <DetailField
          label="Wallet Address"
          value={data.walletAddress}
          copyValue={data.walletAddress}
          mono
        />
        <DetailField
          label="Auth Method"
          value={data.authMethod === 'api_key' ? 'API Key' : 'Dashboard'}
        />
        <DetailField
          label="API Key"
          value={
            data.apiKeyName && data.apiKeyPrefix
              ? `${data.apiKeyPrefix} · ${data.apiKeyName}`
              : data.apiKeyName ?? data.apiKeyPrefix ?? '—'
          }
        />
        <DetailField label="Created At" value={formatFullDate(data.createdAt)} />
        <DetailField label="Completed At" value={formatFullDate(data.completedAt)} />
      </div>
    </div>
  );
}

// --- List components ---

interface TransactionListProps {
  items: TransactionListItem[];
  total: number;
  page: number;
  totalPages: number;
  status: string;
  chainId: number;
  loading: boolean;
  error: string | null;
  onStatusChange: (v: string) => void;
  onChainChange: (v: number) => void;
  onPageChange: (v: number) => void;
  onRefresh: () => void;
  onRowClick: (id: string) => void;
}

function TransactionList({
  items, total, page, totalPages, status, chainId, loading, error,
  onStatusChange, onChainChange, onPageChange, onRefresh, onRowClick,
}: TransactionListProps) {
  return (
    <>
      {/* Filters */}
      <DashboardCard title="Filters" description="Narrow down transaction history.">
        <div className="flex flex-wrap gap-3">
          <select
            value={status}
            onChange={(e) => onStatusChange(e.target.value)}
            className="rounded-lg border border-brand-border bg-white px-3 py-2 text-sm text-brand-text focus:outline-none focus:ring-2 focus:ring-brand-accent/30"
          >
            {TX_STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <select
            value={chainId}
            onChange={(e) => onChainChange(Number(e.target.value))}
            className="rounded-lg border border-brand-border bg-white px-3 py-2 text-sm text-brand-text focus:outline-none focus:ring-2 focus:ring-brand-accent/30"
          >
            {CHAIN_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <button
            onClick={onRefresh}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-brand-border bg-white px-3 py-2 text-sm font-medium text-brand-text transition-colors hover:bg-brand-bg disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </DashboardCard>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        </div>
      )}

      {/* Table */}
      <DashboardCard title={`Transactions (${total})`}>
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-brand-muted" />
          </div>
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-sm text-brand-muted">No transactions found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-brand-border text-xs font-semibold uppercase tracking-wider text-brand-muted">
                  <th className="pb-3 pr-4">Status</th>
                  <th className="pb-3 pr-4">Chain</th>
                  <th className="pb-3 pr-4">Type</th>
                  <th className="pb-3 pr-4">Tx Hash</th>
                  <th className="pb-3 pr-4">API Key</th>
                  <th className="pb-3 pr-4">Created</th>
                  <th className="pb-3">Completed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-brand-border">
                {items.map((tx) => (
                  <tr
                    key={tx.id}
                    onClick={() => onRowClick(tx.id)}
                    className="group cursor-pointer transition-colors hover:bg-brand-accent/5"
                  >
                    <td className="py-3 pr-4">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${statusBadge(tx.status)}`}>
                        {tx.status}
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-brand-text">{chainName(tx.chainId)}</td>
                    <td className="py-3 pr-4 text-brand-muted">{tx.operationType}</td>
                    <td className="py-3 pr-4 font-mono text-xs text-brand-muted">
                      {tx.txHash ? truncateAddress(tx.txHash) : '—'}
                    </td>
                    <td className="py-3 pr-4 text-brand-muted">
                      {tx.apiKeyName ?? tx.apiKeyPrefix ?? '—'}
                    </td>
                    <td className="py-3 pr-4 text-brand-muted" title={formatFullDate(tx.createdAt)}>
                      {formatRelativeTime(tx.createdAt)}
                    </td>
                    <td className="py-3 text-brand-muted" title={formatFullDate(tx.completedAt)}>
                      {formatRelativeTime(tx.completedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between border-t border-brand-border pt-4">
            <p className="text-xs text-brand-muted">
              Page {page} of {totalPages} · {total} total
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => onPageChange(Math.max(1, page - 1))}
                disabled={page <= 1}
                className="inline-flex items-center gap-1 rounded-lg border border-brand-border bg-white px-3 py-1.5 text-xs font-medium text-brand-text transition-colors hover:bg-brand-bg disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ArrowLeft className="h-3 w-3" /> Previous
              </button>
              <button
                onClick={() => onPageChange(Math.min(totalPages, page + 1))}
                disabled={page >= totalPages}
                className="inline-flex items-center gap-1 rounded-lg border border-brand-border bg-white px-3 py-1.5 text-xs font-medium text-brand-text transition-colors hover:bg-brand-bg disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next <ArrowRight className="h-3 w-3" />
              </button>
            </div>
          </div>
        )}
      </DashboardCard>
    </>
  );
}

interface SigningRequestListProps {
  items: SigningRequestListItem[];
  total: number;
  page: number;
  totalPages: number;
  type: string;
  status: string;
  chainId: number;
  loading: boolean;
  error: string | null;
  onTypeChange: (v: string) => void;
  onStatusChange: (v: string) => void;
  onChainChange: (v: number) => void;
  onPageChange: (v: number) => void;
  onRefresh: () => void;
  onRowClick: (id: string) => void;
}

function SigningRequestList({
  items, total, page, totalPages, type, status, chainId, loading, error,
  onTypeChange, onStatusChange, onChainChange, onPageChange, onRefresh, onRowClick,
}: SigningRequestListProps) {
  return (
    <>
      {/* Filters */}
      <DashboardCard title="Filters" description="Narrow down signing request history.">
        <div className="flex flex-wrap gap-3">
          <select
            value={type}
            onChange={(e) => onTypeChange(e.target.value)}
            className="rounded-lg border border-brand-border bg-white px-3 py-2 text-sm text-brand-text focus:outline-none focus:ring-2 focus:ring-brand-accent/30"
          >
            {SR_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <select
            value={status}
            onChange={(e) => onStatusChange(e.target.value)}
            className="rounded-lg border border-brand-border bg-white px-3 py-2 text-sm text-brand-text focus:outline-none focus:ring-2 focus:ring-brand-accent/30"
          >
            {SR_STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <select
            value={chainId}
            onChange={(e) => onChainChange(Number(e.target.value))}
            className="rounded-lg border border-brand-border bg-white px-3 py-2 text-sm text-brand-text focus:outline-none focus:ring-2 focus:ring-brand-accent/30"
          >
            {CHAIN_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <button
            onClick={onRefresh}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-brand-border bg-white px-3 py-2 text-sm font-medium text-brand-text transition-colors hover:bg-brand-bg disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </DashboardCard>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        </div>
      )}

      {/* Table */}
      <DashboardCard title={`Signing Requests (${total})`}>
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-brand-muted" />
          </div>
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-sm text-brand-muted">No signing requests found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-brand-border text-xs font-semibold uppercase tracking-wider text-brand-muted">
                  <th className="pb-3 pr-4">Status</th>
                  <th className="pb-3 pr-4">Type</th>
                  <th className="pb-3 pr-4">Chain</th>
                  <th className="pb-3 pr-4">Wallet</th>
                  <th className="pb-3 pr-4">API Key</th>
                  <th className="pb-3 pr-4">Created</th>
                  <th className="pb-3">Completed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-brand-border">
                {items.map((sr) => (
                  <tr
                    key={sr.id}
                    onClick={() => onRowClick(sr.id)}
                    className="group cursor-pointer transition-colors hover:bg-brand-accent/5"
                  >
                    <td className="py-3 pr-4">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${statusBadge(sr.status)}`}>
                        {sr.status}
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-brand-text">
                      <span className="inline-flex items-center rounded-md bg-brand-accent/10 px-2 py-0.5 text-xs font-medium text-brand-accent">
                        {sr.type === 'typed_data' ? 'EIP-712' : sr.type}
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-brand-text">{chainName(sr.chainId)}</td>
                    <td className="py-3 pr-4 font-mono text-xs text-brand-muted">
                      {truncateAddress(sr.walletAddress)}
                    </td>
                    <td className="py-3 pr-4 text-brand-muted">
                      {sr.apiKeyName ?? sr.apiKeyPrefix ?? '—'}
                    </td>
                    <td className="py-3 pr-4 text-brand-muted" title={formatFullDate(sr.createdAt)}>
                      {formatRelativeTime(sr.createdAt)}
                    </td>
                    <td className="py-3 text-brand-muted" title={formatFullDate(sr.completedAt)}>
                      {formatRelativeTime(sr.completedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between border-t border-brand-border pt-4">
            <p className="text-xs text-brand-muted">
              Page {page} of {totalPages} · {total} total
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => onPageChange(Math.max(1, page - 1))}
                disabled={page <= 1}
                className="inline-flex items-center gap-1 rounded-lg border border-brand-border bg-white px-3 py-1.5 text-xs font-medium text-brand-text transition-colors hover:bg-brand-bg disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ArrowLeft className="h-3 w-3" /> Previous
              </button>
              <button
                onClick={() => onPageChange(Math.min(totalPages, page + 1))}
                disabled={page >= totalPages}
                className="inline-flex items-center gap-1 rounded-lg border border-brand-border bg-white px-3 py-1.5 text-xs font-medium text-brand-text transition-colors hover:bg-brand-bg disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next <ArrowRight className="h-3 w-3" />
              </button>
            </div>
          </div>
        )}
      </DashboardCard>
    </>
  );
}
