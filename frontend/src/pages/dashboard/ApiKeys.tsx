import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useUser } from '@openfort/react';
import { AlertTriangle, Plus, RotateCcw, Trash2, Loader2, X } from 'lucide-react';
import { CopyButton } from '@/components/CopyButton';
import { DashboardPage, DashboardCard } from './components/DashboardPage';
import {
  listApiKeysAuth,
  createApiKeyAuth,
  revokeApiKeyAuth,
  revokeAllApiKeysAuth,
  refreshApiKey as refreshApiKeyApi,
  getApiErrorMessage,
  getApiBaseUrlForDisplay,
  type ApiKeyRecord,
} from '@/lib/api';
import { requestStepUpToken } from './step-up';

const RAW_KEY_NOTICE_TTL_MS = 2 * 60 * 1000;
const MAX_ACTIVE_API_KEYS = 10;
const API_KEY_EXPIRY_SOON_MS = 14 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const KEY_STATUS_FILTER_STORAGE_KEY = 'sofa-one.apiKeys.statusFilter';

type KeyStatusFilter = 'all' | 'active' | 'revoked';

const KEY_STATUS_FILTERS: Array<{ value: KeyStatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'revoked', label: 'Revoked' },
];

function isKeyStatusFilter(value: string | null): value is KeyStatusFilter {
  return value === 'all' || value === 'active' || value === 'revoked';
}

function getStoredKeyStatusFilter(): KeyStatusFilter {
  try {
    const storedValue = window.localStorage.getItem(KEY_STATUS_FILTER_STORAGE_KEY);
    return isKeyStatusFilter(storedValue) ? storedValue : 'active';
  } catch {
    return 'active';
  }
}

function persistKeyStatusFilter(value: KeyStatusFilter) {
  try {
    window.localStorage.setItem(KEY_STATUS_FILTER_STORAGE_KEY, value);
  } catch {
    // Ignore storage failures so private browsing or blocked storage never breaks key management.
  }
}

function getRelativeDateSummary(value: string | null, emptyLabel: string) {
  if (!value) {
    return { label: emptyLabel, detail: null, tone: 'text-brand-muted' };
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { label: 'Invalid date', detail: 'Check key metadata', tone: 'text-red-700' };
  }

  const elapsedMs = Date.now() - date.getTime();
  const absoluteLabel = date.toLocaleDateString();
  if (elapsedMs < 0) {
    return { label: absoluteLabel, detail: 'Future date', tone: 'text-brand-muted' };
  }

  if (elapsedMs < ONE_DAY_MS) {
    return { label: 'Today', detail: absoluteLabel, tone: 'text-brand-muted' };
  }

  const elapsedDays = Math.floor(elapsedMs / ONE_DAY_MS);
  return {
    label: `${elapsedDays}d ago`,
    detail: absoluteLabel,
    tone: 'text-brand-muted',
  };
}

function getKeyExpirySortTime(key: ApiKeyRecord) {
  if (!key.expiresAt) return Number.POSITIVE_INFINITY;

  const expiryTime = new Date(key.expiresAt).getTime();
  return Number.isNaN(expiryTime) ? Number.NEGATIVE_INFINITY : expiryTime;
}

function getLastUsedSortTime(key: ApiKeyRecord) {
  if (!key.lastUsedAt) return Number.NEGATIVE_INFINITY;

  const lastUsedTime = new Date(key.lastUsedAt).getTime();
  return Number.isNaN(lastUsedTime) ? Number.NEGATIVE_INFINITY : lastUsedTime;
}

function getKeyExpirySummary(expiresAt: string | null) {
  if (!expiresAt) {
    return { label: 'No expiry', detail: 'Manual revoke only', tone: 'text-brand-muted' };
  }

  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) {
    return { label: 'Invalid expiry', detail: 'Check key metadata', tone: 'text-red-700' };
  }

  const timeUntilExpiry = expiry.getTime() - Date.now();
  const dateLabel = expiry.toLocaleDateString();
  if (timeUntilExpiry <= 0) {
    return { label: 'Expired', detail: dateLabel, tone: 'text-red-700' };
  }

  const daysUntilExpiry = Math.ceil(timeUntilExpiry / ONE_DAY_MS);
  if (timeUntilExpiry <= API_KEY_EXPIRY_SOON_MS) {
    return {
      label: daysUntilExpiry <= 1 ? 'Expires today' : `${daysUntilExpiry}d left`,
      detail: dateLabel,
      tone: 'text-amber-700',
    };
  }

  return { label: dateLabel, detail: `${daysUntilExpiry}d left`, tone: 'text-brand-muted' };
}

function truncateUsageValue(value: string, maxLength = 36) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

export default function ApiKeysPage() {
  const { getAccessToken, isAuthenticated, isLoading: authLoading, user } = useUser();
  const getToken = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) {
      throw new Error('Openfort session is not ready. Refresh and sign in again.');
    }
    return token;
  }, [getAccessToken]);
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyAllowedIps, setNewKeyAllowedIps] = useState('');
  const [newKeyAllowedContracts, setNewKeyAllowedContracts] = useState('');
  const [newKeyAllowedSelectors, setNewKeyAllowedSelectors] = useState('');
  const [newKeyDailySpendLimit, setNewKeyDailySpendLimit] = useState('');
  const [newKeyMonthlySpendLimit, setNewKeyMonthlySpendLimit] = useState('');
  const [newKeyPermissions, setNewKeyPermissions] = useState({
    canSign: false,
    canSendTransaction: false,
    canReadTransactionStatus: true,
    canUseEoaExecution: false,
  });
  const [newRawKey, setNewRawKey] = useState<string | null>(null);
  const [newKeyExpiresAt, setNewKeyExpiresAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [keysRefreshing, setKeysRefreshing] = useState(false);
  const [keyStatusFilter, setKeyStatusFilter] = useState<KeyStatusFilter>(getStoredKeyStatusFilter);
  const apiBaseUrl = getApiBaseUrlForDisplay();
  const quickStartCurl = `curl -X POST ${apiBaseUrl}/v1/transactions/send \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "chainId": 84532,
    "executionMode": "session_key",
    "idempotencyKey": "order-abc-123",
    "interactions": [{
      "to": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "data": "0xa9059cbb0000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000000f4240",
      "value": "0"
    }]
  }'`;
  const sortedKeys = [...keys].sort((a, b) => {
    if (a.revoked !== b.revoked) return Number(a.revoked) - Number(b.revoked);

    if (!a.revoked && !b.revoked) {
      const expirySort = getKeyExpirySortTime(a) - getKeyExpirySortTime(b);
      if (expirySort !== 0) return expirySort;

      return getLastUsedSortTime(b) - getLastUsedSortTime(a);
    }

    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
  const visibleKeys = sortedKeys.filter((key) => {
    if (keyStatusFilter === 'active') return !key.revoked;
    if (keyStatusFilter === 'revoked') return key.revoked;
    return true;
  });
  const activeKeyCount = keys.filter((key) => !key.revoked).length;
  const revokedKeyCount = keys.length - activeKeyCount;
  const remainingKeySlots = Math.max(MAX_ACTIVE_API_KEYS - activeKeyCount, 0);
  const hasReachedKeyLimit = remainingKeySlots === 0;
  const selectedKeyStatusFilter = KEY_STATUS_FILTERS.find((filter) => filter.value === keyStatusFilter);

  const fetchKeys = useCallback(async () => {
    setKeysRefreshing(true);
    setListError(null);
    try {
      const data = await listApiKeysAuth(getToken);
      setKeys(data);
    } catch (err: unknown) {
      setListError(getApiErrorMessage(err));
    } finally {
      setLoading(false);
      setKeysRefreshing(false);
    }
  }, [getToken]);

  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated || !user) {
      setLoading(false);
      return;
    }
    fetchKeys();
  }, [authLoading, fetchKeys, isAuthenticated, user]);

  useEffect(() => {
    if (!newRawKey) return;

    const timeoutId = window.setTimeout(() => {
      setNewRawKey(null);
      setNewKeyExpiresAt(null);
    }, RAW_KEY_NOTICE_TTL_MS);

    return () => window.clearTimeout(timeoutId);
  }, [newRawKey]);

  useEffect(() => {
    persistKeyStatusFilter(keyStatusFilter);
  }, [keyStatusFilter]);

  async function handleCreate() {
    if (hasReachedKeyLimit) {
      setActionError('Revoke an active API key before creating another one.');
      return;
    }

    const trimmedName = newKeyName.trim();
    if (!trimmedName) {
      setActionError('Enter a unique name for this API key.');
      return;
    }

    const allowedIps = newKeyAllowedIps
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean);

    const allowedContracts = newKeyAllowedContracts
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean);

    const allowedFunctionSelectors = newKeyAllowedSelectors
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean);

    const spendLimits: { daily?: string; monthly?: string } = {};
    if (newKeyDailySpendLimit.trim()) spendLimits.daily = newKeyDailySpendLimit.trim();
    if (newKeyMonthlySpendLimit.trim()) spendLimits.monthly = newKeyMonthlySpendLimit.trim();

    setActionLoading(true);
    setActionError(null);
    try {
      const stepUpToken = await requestStepUpToken(getToken);
      const result = await createApiKeyAuth(
        getToken,
        {
          name: trimmedName,
          ...(allowedIps.length > 0 ? { allowedIps } : {}),
          ...(allowedContracts.length > 0 ? { allowedContracts } : {}),
          ...(allowedFunctionSelectors.length > 0 ? { allowedFunctionSelectors } : {}),
          ...(Object.keys(spendLimits).length > 0 ? { spendLimits } : {}),
          permissions: newKeyPermissions,
        },
        stepUpToken,
      );
      setNewRawKey(result.rawKey);
      setNewKeyExpiresAt(result.expiresAt);
      setNewKeyName('');
      setNewKeyAllowedIps('');
      setNewKeyAllowedContracts('');
      setNewKeyAllowedSelectors('');
      setNewKeyDailySpendLimit('');
      setNewKeyMonthlySpendLimit('');
      setNewKeyPermissions({
        canSign: false,
        canSendTransaction: false,
        canReadTransactionStatus: true,
        canUseEoaExecution: false,
      });
      await fetchKeys();
    } catch (err: unknown) {
      setActionError(getApiErrorMessage(err));
    } finally {
      setActionLoading(false);
    }
  }

  async function handleRevoke(key: ApiKeyRecord) {
    const label = key.name ? `${key.name} (${key.displayPrefix})` : key.displayPrefix;
    if (
      !confirm(`Revoke API key ${label}? This immediately stops any backend using it and cannot be undone.`)
    ) return;
    setActionLoading(true);
    setActionError(null);
    try {
      const stepUpToken = await requestStepUpToken(getToken);
      await revokeApiKeyAuth(getToken, key.id, stepUpToken);
      await fetchKeys();
    } catch (err: unknown) {
      setActionError(getApiErrorMessage(err));
    } finally {
      setActionLoading(false);
    }
  }

  async function handleRefresh() {
    if (
      !confirm(
        `Rotate ${activeKeyCount} active API key${activeKeyCount === 1 ? '' : 's'}? This revokes every active key, creates one replacement, and shows the new raw key only once.`,
      )
    ) {
      return;
    }
    setActionLoading(true);
    setActionError(null);
    try {
      const result = await refreshApiKeyApi(getToken);
      setNewRawKey(result.apiKey);
      await fetchKeys();
    } catch (err: unknown) {
      setActionError(getApiErrorMessage(err));
    } finally {
      setActionLoading(false);
    }
  }

  async function handleRevokeAll() {
    if (activeKeyCount === 0) return;
    if (
      !confirm(
        `Emergency revoke ${activeKeyCount} active API key${activeKeyCount === 1 ? '' : 's'}? This immediately stops all backend integrations and does not create a replacement.`,
      )
    ) {
      return;
    }
    setActionLoading(true);
    setActionError(null);
    try {
      const stepUpToken = await requestStepUpToken(getToken);
      await revokeAllApiKeysAuth(getToken, stepUpToken);
      setNewRawKey(null);
      setNewKeyExpiresAt(null);
      await fetchKeys();
    } catch (err: unknown) {
      setActionError(getApiErrorMessage(err));
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <DashboardPage
      title="API Keys"
      description="Create keys your backend uses to submit transactions through your authorized EOA."
    >
      {actionError && (
        <div className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800 shadow-sm">
          <AlertTriangle className="h-5 w-5 shrink-0 text-red-600" />
          {actionError}
        </div>
      )}

      {listError && (
        <div className="flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 shrink-0 text-red-600" />
            <span>{listError}</span>
          </div>
          <button
            onClick={fetchKeys}
            disabled={keysRefreshing || actionLoading}
            className="inline-flex items-center justify-center gap-1.5 rounded-full border border-red-200 bg-white px-4 py-1.5 text-xs font-semibold text-red-700 transition-all hover:border-red-300 hover:bg-red-100 disabled:opacity-50"
          >
            {keysRefreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
            Retry keys
          </button>
        </div>
      )}

      {newRawKey && (
        <div className="relative rounded-2xl border border-amber-200 bg-amber-50 p-5 pr-14 shadow-sm">
          <button
            onClick={() => {
              setNewRawKey(null);
              setNewKeyExpiresAt(null);
            }}
            className="absolute right-4 top-4 inline-flex items-center justify-center rounded-full border border-amber-300 p-1 text-amber-600 hover:bg-amber-100 transition-colors"
            aria-label="Dismiss new API key notice"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <p className="text-sm font-medium text-amber-800">
            New backend API key created — save it now (shown only once):
          </p>
          <p className="mt-1 text-xs text-amber-700">
            Use this as the <code>X-API-Key</code> header from your server. Do not expose it in browser code.
            {' '}
            {newKeyExpiresAt ? `This key expires on ${new Date(newKeyExpiresAt).toLocaleDateString()}. ` : ''}
            This notice auto-hides in 2 minutes.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="flex-1 break-all rounded-xl bg-amber-100/50 border border-amber-200/50 px-4 py-3 font-mono text-sm text-amber-900 shadow-sm">
              {newRawKey}
            </code>
            <CopyButton text={newRawKey} className="shrink-0 border-amber-300 text-amber-600 hover:bg-amber-100" />
          </div>
        </div>
      )}

      <DashboardCard
        title="Create New Key"
        description="Name the app or environment that will use this key. New keys expire by default and can be revoked anytime."
      >
        <div className="mt-5 rounded-xl border border-brand-border bg-brand-bg/60 p-4 text-sm leading-6 text-brand-muted">
          {loading ? (
            'Checking active API key capacity…'
          ) : (
            <>
              <span className="font-semibold text-brand-text">{activeKeyCount}</span> of{' '}
              <span className="font-semibold text-brand-text">{MAX_ACTIVE_API_KEYS}</span> active keys used.{' '}
              {hasReachedKeyLimit
                ? 'Revoke an active key before creating another one.'
                : `${remainingKeySlots} active ${remainingKeySlots === 1 ? 'slot remains' : 'slots remain'}.`}
            </>
          )}
        </div>
        <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-2 lg:flex-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted block">Key Name</label>
            <input
              type="text"
              placeholder="e.g. Production Backend"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              required
              className="w-full rounded-lg border border-brand-border px-4 py-2.5 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent placeholder:text-brand-muted bg-white shadow-sm transition-colors"
            />
            <p className="text-xs leading-5 text-brand-muted">
              Use a unique active name per environment or app. The raw key is shown once after creation, so copy it
              directly into your backend secret store. If you do not choose a custom expiry via the API, the backend
              applies a 90-day default.
            </p>
          </div>
          <div className="space-y-2 lg:flex-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted block">
              IP allowlist <span className="font-semibold normal-case tracking-normal text-brand-muted">optional</span>
            </label>
            <textarea
              rows={3}
              placeholder="192.0.2.10, 203.0.113.0/24"
              value={newKeyAllowedIps}
              onChange={(e) => setNewKeyAllowedIps(e.target.value)}
              className="w-full rounded-lg border border-brand-border px-4 py-2.5 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent placeholder:text-brand-muted bg-white shadow-sm transition-colors"
            />
            <p className="text-xs leading-5 text-brand-muted">
              Restrict this key to trusted backend egress IPs. Leave blank only for local development or rotating IP environments.
            </p>
          </div>
          <div className="space-y-2 lg:flex-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted block">
              Contract allowlist <span className="font-semibold normal-case tracking-normal text-brand-muted">optional</span>
            </label>
            <textarea
              rows={2}
              placeholder="0x1234…, 0x5678…"
              value={newKeyAllowedContracts}
              onChange={(e) => setNewKeyAllowedContracts(e.target.value)}
              className="w-full rounded-lg border border-brand-border px-4 py-2.5 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent placeholder:text-brand-muted bg-white shadow-sm transition-colors"
            />
            <p className="text-xs leading-5 text-brand-muted">
              Restrict transactions and signing to these contract addresses. Leave blank to allow all.
            </p>
          </div>
          <div className="space-y-2 lg:flex-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted block">
              Function selectors <span className="font-semibold normal-case tracking-normal text-brand-muted">optional</span>
            </label>
            <textarea
              rows={2}
              placeholder="0xa9059cbb, 0x095ea7b3"
              value={newKeyAllowedSelectors}
              onChange={(e) => setNewKeyAllowedSelectors(e.target.value)}
              className="w-full rounded-lg border border-brand-border px-4 py-2.5 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent placeholder:text-brand-muted bg-white shadow-sm transition-colors"
            />
            <p className="text-xs leading-5 text-brand-muted">
              Restrict transactions to these 4-byte function selectors. Leave blank to allow all.
            </p>
          </div>
          <div className="grid gap-5 sm:grid-cols-2 lg:col-span-2">
            <div className="space-y-2">
              <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted block">
                Daily spend limit (wei) <span className="font-semibold normal-case tracking-normal text-brand-muted">optional</span>
              </label>
              <input
                type="text"
                placeholder="e.g. 1000000000000000000 (1 ETH)"
                value={newKeyDailySpendLimit}
                onChange={(e) => setNewKeyDailySpendLimit(e.target.value)}
                className="w-full rounded-lg border border-brand-border px-4 py-2.5 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent placeholder:text-brand-muted bg-white shadow-sm transition-colors"
              />
              <p className="text-xs leading-5 text-brand-muted">
                Max total native-token value per transaction, in wei. Leave blank for no limit.
              </p>
            </div>
            <div className="space-y-2">
              <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted block">
                Monthly spend limit (wei) <span className="font-semibold normal-case tracking-normal text-brand-muted">optional</span>
              </label>
              <input
                type="text"
                placeholder="e.g. 30000000000000000000 (30 ETH)"
                value={newKeyMonthlySpendLimit}
                onChange={(e) => setNewKeyMonthlySpendLimit(e.target.value)}
                className="w-full rounded-lg border border-brand-border px-4 py-2.5 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent placeholder:text-brand-muted bg-white shadow-sm transition-colors"
              />
              <p className="text-xs leading-5 text-brand-muted">
                Max total native-token value per transaction, in wei. Leave blank for no limit.
              </p>
            </div>
          </div>
          <div className="space-y-3 rounded-xl border border-brand-border bg-brand-bg/60 p-4 lg:col-span-2">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">Permissions</p>
              <p className="mt-1 text-xs leading-5 text-brand-muted">
                Start read-only, then grant only the capabilities this backend needs. EOA execution is privileged and
                should stay off unless this key is for a reviewed EOA-signing workflow.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ['canReadTransactionStatus', 'Read status', 'Fetch transaction status by id.'],
                ['canSign', 'Sign messages', 'Use /v1/wallets/sign.'],
                ['canSendTransaction', 'Send transactions', 'Use /v1/transactions/send.'],
                ['canUseEoaExecution', 'Use EOA execution', 'Privileged backend EOA mode.'],
              ].map(([permission, label, description]) => (
                <label
                  key={permission}
                  className="flex cursor-pointer gap-3 rounded-lg border border-brand-border bg-white p-3 text-sm shadow-sm transition-colors hover:border-brand-accent"
                >
                  <input
                    type="checkbox"
                    checked={newKeyPermissions[permission as keyof typeof newKeyPermissions]}
                    onChange={(event) =>
                      setNewKeyPermissions((current) => ({
                        ...current,
                        [permission]: event.target.checked,
                      }))
                    }
                    className="mt-1 h-4 w-4 rounded border-brand-border text-brand-accent focus:ring-brand-accent"
                  />
                  <span>
                    <span className="block font-semibold text-brand-text">{label}</span>
                    <span className="block text-xs leading-5 text-brand-muted">{description}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div className="lg:col-span-2">
            <button
              onClick={handleCreate}
              disabled={loading || actionLoading || !newKeyName.trim() || hasReachedKeyLimit}
              className="flex items-center justify-center gap-2 w-full rounded-full bg-brand-text px-8 py-2.5 text-sm font-semibold text-white shadow-lg hover:bg-brand-text/90 hover:shadow-xl hover:-translate-y-0.5 transition-all disabled:opacity-50 lg:w-auto"
            >
              <Plus className="h-4 w-4" />
              Create Key
            </button>
          </div>
        </div>
      </DashboardCard>

      <div className="rounded-2xl border border-brand-border bg-white shadow-xl relative overflow-hidden ring-1 ring-black/5">
        <div className="p-7 border-b border-brand-border">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="text-xl font-bold font-serif text-brand-text">Your Keys</h2>
              <p className="mt-1 text-xs text-brand-muted">
                Active keys are ordered by soonest expiry, then most recent use, so lifecycle risks stay visible.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <button
                type="button"
                onClick={handleRevokeAll}
                disabled={loading || actionLoading || activeKeyCount === 0}
                className="inline-flex items-center justify-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-4 py-1.5 text-xs font-semibold text-red-700 transition-all hover:border-red-300 hover:bg-red-100 disabled:opacity-50"
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                Revoke all
              </button>
              <div className="inline-flex rounded-full border border-brand-border bg-brand-bg p-1">
                {KEY_STATUS_FILTERS.map((filter) => (
                  <button
                    key={filter.value}
                    type="button"
                    onClick={() => setKeyStatusFilter(filter.value)}
                    className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                      keyStatusFilter === filter.value
                        ? 'bg-white text-brand-text shadow-sm'
                        : 'text-brand-muted hover:text-brand-text'
                    }`}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
              {keysRefreshing && !loading && (
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand-muted">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Refreshing
                </span>
              )}
            </div>
          </div>
          {!loading && keys.length > 0 && (
            <div className="mt-4 flex flex-col gap-3 text-xs text-brand-muted sm:flex-row sm:items-center sm:justify-between">
              <p>
                Showing {visibleKeys.length} of {keys.length} keys · {activeKeyCount} active · {revokedKeyCount} revoked
              </p>
              {keyStatusFilter !== 'all' && (
                <div className="inline-flex w-fit items-center gap-2 rounded-full border border-brand-border bg-brand-bg px-3 py-1 font-semibold text-brand-text">
                  <span>Filtered: {selectedKeyStatusFilter?.label ?? keyStatusFilter}</span>
                  <button
                    type="button"
                    onClick={() => setKeyStatusFilter('all')}
                    className="text-brand-muted underline-offset-2 transition-colors hover:text-brand-accent hover:underline"
                  >
                    Show all
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        
        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-brand-accent" />
          </div>
        ) : listError && keys.length === 0 ? (
          <div className="px-7 py-12 text-center">
            <p className="text-base font-semibold text-brand-text">Could not load API keys</p>
            <p className="mt-2 text-sm text-brand-muted">
              Check your session or network connection, then try again.
            </p>
            <button
              onClick={fetchKeys}
              disabled={keysRefreshing || actionLoading}
              className="mt-5 inline-flex items-center justify-center gap-2 rounded-full border border-brand-border bg-white px-5 py-2 text-sm font-semibold text-brand-text transition-all hover:border-brand-accent hover:bg-brand-bg disabled:opacity-50"
            >
              {keysRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
              Retry loading keys
            </button>
          </div>
        ) : keys.length === 0 ? (
          <div className="px-7 py-12 text-center">
            <p className="text-base font-semibold text-brand-text">Create your first API key</p>
            <p className="mt-2 text-sm text-brand-muted">
              Authorize your wallet first, then create a key for backend transaction requests.
            </p>
            <div className="mt-5 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                to="/dashboard"
                className="inline-flex items-center justify-center rounded-full bg-brand-text px-5 py-2 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-brand-text/90"
              >
                Review wallet setup
              </Link>
              <Link
                to="/dashboard/docs"
                className="inline-flex items-center justify-center rounded-full border border-brand-border bg-white px-5 py-2 text-sm font-semibold text-brand-text transition-all hover:border-brand-accent hover:bg-brand-bg"
              >
                Read API docs
              </Link>
            </div>
          </div>
        ) : visibleKeys.length === 0 ? (
          <div className="px-7 py-12 text-center">
            <p className="text-base font-semibold text-brand-text">No {keyStatusFilter} keys to show</p>
            <p className="mt-2 text-sm text-brand-muted">
              Switch filters to review the rest of your API key history.
            </p>
            <button
              type="button"
              onClick={() => setKeyStatusFilter('all')}
              className="mt-5 inline-flex items-center justify-center rounded-full border border-brand-border bg-white px-5 py-2 text-sm font-semibold text-brand-text transition-all hover:border-brand-accent hover:bg-brand-bg"
            >
              Show all keys
            </button>
          </div>
        ) : (
          <div className="divide-y divide-brand-border">
            <div className="hidden grid-cols-[140px_84px_minmax(160px,1fr)_minmax(150px,1fr)_110px_120px_110px_36px] items-center gap-4 px-7 py-3 text-[11px] font-bold uppercase tracking-widest text-brand-muted md:grid">
              <span>Key</span>
              <span>Status</span>
              <span>Name</span>
              <span>Permissions</span>
              <span>Last Used</span>
              <span>Expires</span>
              <span>Created</span>
              <span className="sr-only">Actions</span>
            </div>
            {visibleKeys.map((key) => {
              const lastUsed = getRelativeDateSummary(key.lastUsedAt, 'Never');
              const created = getRelativeDateSummary(key.createdAt, 'Unknown');
              const expiry = getKeyExpirySummary(key.expiresAt);
              const allowedContracts = key.allowedContracts ?? [];
              const allowedFunctionSelectors = key.allowedFunctionSelectors ?? [];

              return (
                <div key={key.id} className="grid gap-3 px-7 py-4 transition-colors hover:bg-brand-surface md:grid-cols-[140px_84px_minmax(160px,1fr)_minmax(150px,1fr)_110px_120px_110px_36px] md:items-center md:gap-4">
                  <span className="flex min-w-0 items-center gap-2 font-mono text-sm text-brand-text">
                    <span className="min-w-0 truncate">{key.displayPrefix}</span>
                    <CopyButton
                      text={key.displayPrefix}
                      className="h-7 w-7 shrink-0 border-brand-border/80 bg-white text-brand-muted hover:text-brand-accent"
                    />
                  </span>
                  <span className={`w-fit rounded-full px-2.5 py-0.5 text-xs font-semibold ${key.revoked ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                    {key.revoked ? 'Revoked' : 'Active'}
                  </span>
                  <span className="min-w-0 truncate text-sm text-brand-muted">
                    <span className="font-semibold text-brand-text md:hidden">Name: </span>
                    {key.name || '—'}
                  </span>
                  <span className="flex flex-wrap gap-1.5 text-[11px] font-semibold text-brand-muted">
                    <span className="font-semibold text-brand-text md:hidden">Permissions: </span>
                    {key.permissions.canReadTransactionStatus && <span className="rounded-full bg-brand-bg px-2 py-0.5">status</span>}
                    {key.permissions.canSign && <span className="rounded-full bg-brand-bg px-2 py-0.5">sign</span>}
                    {key.permissions.canSendTransaction && <span className="rounded-full bg-brand-bg px-2 py-0.5">send</span>}
                    {key.permissions.canUseEoaExecution && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800">eoa</span>}
                    {!key.permissions.canReadTransactionStatus &&
                      !key.permissions.canSign &&
                      !key.permissions.canSendTransaction &&
                      !key.permissions.canUseEoaExecution && <span>none</span>}
                  </span>
                  {(allowedContracts.length > 0 || allowedFunctionSelectors.length > 0) && (
                    <span className="mt-1 flex flex-wrap gap-1 text-[10px] text-brand-muted">
                      {allowedContracts.length > 0 && (
                        <span className="rounded-full bg-blue-50 px-1.5 py-0.5 text-blue-700" title={allowedContracts.join(', ')}>
                          {allowedContracts.length} contract{allowedContracts.length > 1 ? 's' : ''}
                        </span>
                      )}
                      {allowedFunctionSelectors.length > 0 && (
                        <span className="rounded-full bg-purple-50 px-1.5 py-0.5 text-purple-700" title={allowedFunctionSelectors.join(', ')}>
                          {allowedFunctionSelectors.length} selector{allowedFunctionSelectors.length > 1 ? 's' : ''}
                        </span>
                      )}
                    </span>
                  )}
                  {(key.dailySpendLimit || key.monthlySpendLimit) && (
                    <span className="mt-1 flex flex-wrap gap-1 text-[10px] text-brand-muted">
                      {key.dailySpendLimit && (
                        <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-amber-700">
                          Daily: {BigInt(key.dailySpendLimit) >= 1_000_000_000_000_000_000n
                            ? `${(Number(BigInt(key.dailySpendLimit) / 1_000_000_000_000_000_000n)).toLocaleString()} ETH`
                            : `${Number(key.dailySpendLimit).toLocaleString()} wei`}
                        </span>
                      )}
                      {key.monthlySpendLimit && (
                        <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-amber-700">
                          Monthly: {BigInt(key.monthlySpendLimit) >= 1_000_000_000_000_000_000n
                            ? `${(Number(BigInt(key.monthlySpendLimit) / 1_000_000_000_000_000_000n)).toLocaleString()} ETH`
                            : `${Number(key.monthlySpendLimit).toLocaleString()} wei`}
                        </span>
                      )}
                    </span>
                  )}
                  <span className={`text-xs ${lastUsed.tone}`}>
                    <span className="font-semibold text-brand-text md:hidden">Last used: </span>
                    <span className="font-semibold">{lastUsed.label}</span>
                    {lastUsed.detail && <span className="block text-[11px] opacity-80">{lastUsed.detail}</span>}
                    {key.lastUsedIp && (
                      <span className="block truncate text-[11px] opacity-80" title={key.lastUsedIp}>
                        IP: {key.lastUsedIp}
                      </span>
                    )}
                    {key.lastUsedUserAgent && (
                      <span className="block truncate text-[11px] opacity-80" title={key.lastUsedUserAgent}>
                        UA: {truncateUsageValue(key.lastUsedUserAgent)}
                      </span>
                    )}
                  </span>
                  <span className={`text-xs ${expiry.tone}`}>
                    <span className="font-semibold text-brand-text md:hidden">Expires: </span>
                    <span className="font-semibold">{expiry.label}</span>
                    <span className="block text-[11px] opacity-80">{expiry.detail}</span>
                  </span>
                  <span className={`text-xs ${created.tone}`}>
                    <span className="font-semibold text-brand-text md:hidden">Created: </span>
                    <span className="font-semibold">{created.label}</span>
                    {created.detail && <span className="block text-[11px] opacity-80">{created.detail}</span>}
                  </span>
                  {!key.revoked ? (
                    <button
                      onClick={() => handleRevoke(key)}
                      disabled={actionLoading}
                      className="rounded-full border border-red-200 bg-red-50 p-1.5 text-red-600 hover:bg-red-100 hover:border-red-300 transition-colors disabled:opacity-50 md:justify-self-end"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  ) : (
                    <span className="hidden h-7 w-7 md:block" />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <DashboardCard title="Quick Start">
        <div className="mt-5 space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm leading-6 text-brand-muted">
              Copy this backend-only request once you have saved a key.
            </p>
            <CopyButton text={quickStartCurl} className="w-fit shrink-0" />
          </div>
          <pre className="rounded-xl bg-brand-text p-5 text-sm text-brand-bg font-mono overflow-x-auto shadow-sm">
            {quickStartCurl}
          </pre>
          <p className="text-sm leading-6 text-brand-muted">
            Replace the calldata with your ABI-encoded contract call. Keep API keys on your backend; do not ship them in browser code.
          </p>
        </div>
      </DashboardCard>

      <details className="rounded-2xl border border-red-200 bg-red-50 p-7 shadow-sm">
        <summary className="cursor-pointer select-none text-xl font-bold font-serif text-brand-text">
          Advanced key rotation
        </summary>
        <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="max-w-2xl space-y-2 text-sm text-red-800">
            <p>
              Rotate all keys only if you believe existing keys were exposed. This revokes every active key and creates one replacement.
            </p>
            <p>
              The replacement raw key is shown once. Copy it into your backend secret store before deploying, then remove the old keys from every environment.
            </p>
          </div>
          <button
            onClick={handleRefresh}
            disabled={actionLoading}
            className="flex items-center justify-center gap-1.5 rounded-full border border-red-200 bg-white px-5 py-2 text-xs font-semibold text-red-700 transition-all hover:border-red-300 hover:bg-red-100 disabled:opacity-50"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Rotate All Keys
          </button>
        </div>
      </details>
    </DashboardPage>
  );
}
