import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useUser } from '@openfort/react';
import { AlertTriangle, Plus, RotateCcw, Trash2, Loader2, X, ShieldCheck, Search } from 'lucide-react';
import { CopyButton } from '@/components/CopyButton';
import { DashboardPage, DashboardCard } from './components/DashboardPage';
import {
  listApiKeysAuth,
  listDefiCapabilitiesAuth,
  listDefiCapabilityBundlesAuth,
  createApiKeyAuth,
  updateApiKeyCapabilitiesAuth,
  revokeApiKeyAuth,
  revokeAllApiKeysAuth,
  refreshApiKey as refreshApiKeyApi,
  getApiErrorMessage,
  getApiBaseUrlForDisplay,
  formatApiKeyFrozenReason,
  getApiKeyLifecycleBadgeClass,
  getApiKeyLifecycleLabel,
  getApiKeyLifecycleSortRank,
  getApiKeyLifecycleStatus,
  isApiKeyLifecycleActive,
  matchesApiKeyLifecycleFilter,
  type ApiKeyLifecycleStatus,
  type ApiKeyRecord,
  type DefiCapability,
  type DefiCapabilityBundle,
} from '@/lib/api';
import { requestStepUpToken } from './step-up';
import { getDashboardStepUpToken } from './step-up-session';
import { SUPPORTED_CHAINS } from '@/lib/chains';
import { createBundlePreview, getBundlePreviewDiff, validateBundlePreview, type BundlePreviewSnapshot } from './capability-bundle-preview';
import { capabilityCategory, capabilityGroupsForChain, validCapabilityGroupForChain } from './capability-groups';

const RAW_KEY_NOTICE_TTL_MS = 2 * 60 * 1000;
const MAX_ACTIVE_API_KEYS = 10;
const API_KEY_EXPIRY_SOON_MS = 14 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const KEY_STATUS_FILTER_STORAGE_KEY = 'sofa-one.apiKeys.statusFilter';

const FUNCTION_WARNINGS: Record<string, string> = {
  approve: 'This approval can authorize any spender and any amount, including unlimited approval. Review the spender and amount supplied by your caller.',
  borrow: 'Borrowing can create liquidation risk. Review the amount and terms your caller supplies.',
};

type KeyStatusFilter = 'all' | ApiKeyLifecycleStatus;

const KEY_STATUS_FILTERS: Array<{ value: KeyStatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'frozen', label: 'Frozen' },
  { value: 'expired', label: 'Expired' },
  { value: 'revoked', label: 'Revoked' },
];

function isKeyStatusFilter(value: string | null): value is KeyStatusFilter {
  return (
    value === 'all' ||
    value === 'active' ||
    value === 'frozen' ||
    value === 'expired' ||
    value === 'revoked'
  );
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
  const [capabilities, setCapabilities] = useState<DefiCapability[]>([]);
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(true);
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null);
  const [bundles, setBundles] = useState<DefiCapabilityBundle[]>([]);
  const [bundlesLoading, setBundlesLoading] = useState(true);
  const [bundlesError, setBundlesError] = useState<string | null>(null);
  const [selectedBundleKey, setSelectedBundleKey] = useState('');
  const [bundlePreview, setBundlePreview] = useState<BundlePreviewSnapshot | null>(null);
  const [bundlePreviewError, setBundlePreviewError] = useState<string | null>(null);
  const [newKeyAllowedCapabilityIds, setNewKeyAllowedCapabilityIds] = useState<string[]>([]);
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);
  const [editingCapabilityIds, setEditingCapabilityIds] = useState<string[]>([]);
  const [capabilitySaving, setCapabilitySaving] = useState(false);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [capabilitySearch, setCapabilitySearch] = useState('');
  const [capabilityChainFilter, setCapabilityChainFilter] = useState('all');
  const [capabilityGroupFilter, setCapabilityGroupFilter] = useState('all');
  const [capabilitySelectedOnly, setCapabilitySelectedOnly] = useState(false);
  const [capabilityResultLimit, setCapabilityResultLimit] = useState(30);
  const [selectedManagementOpen, setSelectedManagementOpen] = useState(false);
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
    const statusA = getApiKeyLifecycleStatus(a);
    const statusB = getApiKeyLifecycleStatus(b);
    const rankDiff = getApiKeyLifecycleSortRank(statusA) - getApiKeyLifecycleSortRank(statusB);
    if (rankDiff !== 0) return rankDiff;

    if (statusA === 'active' && statusB === 'active') {
      const expirySort = getKeyExpirySortTime(a) - getKeyExpirySortTime(b);
      if (expirySort !== 0) return expirySort;

      return getLastUsedSortTime(b) - getLastUsedSortTime(a);
    }

    if (statusA === 'frozen' && statusB === 'frozen') {
      const frozenA = a.frozenAt ? new Date(a.frozenAt).getTime() : 0;
      const frozenB = b.frozenAt ? new Date(b.frozenAt).getTime() : 0;
      if (frozenA !== frozenB) return frozenB - frozenA;
    }

    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
  const visibleKeys = sortedKeys.filter((key) => matchesApiKeyLifecycleFilter(key, keyStatusFilter));
  // Usable keys only (revoked > frozen > expired > active). Matches Active filter/label.
  const activeKeyCount = keys.filter((key) => isApiKeyLifecycleActive(key)).length;
  const frozenKeyCount = keys.filter((key) => getApiKeyLifecycleStatus(key) === 'frozen').length;
  const expiredKeyCount = keys.filter((key) => getApiKeyLifecycleStatus(key) === 'expired').length;
  const revokedKeyCount = keys.filter((key) => getApiKeyLifecycleStatus(key) === 'revoked').length;
  // Backend create/rotate/revoke-all still treat non-revoked rows as occupying the 10-key cap.
  const occupiedKeySlots = keys.filter((key) => !key.revoked).length;
  const remainingKeySlots = Math.max(MAX_ACTIVE_API_KEYS - occupiedKeySlots, 0);
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

  const fetchCapabilities = useCallback(async () => {
    setCapabilitiesLoading(true);
    setCapabilitiesError(null);
    try {
      const result = await listDefiCapabilitiesAuth(getToken);
      setCapabilities(result.capabilities);
    } catch (err: unknown) {
      setCapabilitiesError(getApiErrorMessage(err));
    } finally {
      setCapabilitiesLoading(false);
    }
  }, [getToken]);

  const fetchBundles = useCallback(async () => {
    setBundlesLoading(true);
    setBundlesError(null);
    try {
      const response = await listDefiCapabilityBundlesAuth(getToken);
      if (response.schemaVersion !== 1 || typeof response.currentCatalogManifestHash !== 'string' || !Array.isArray(response.bundles)) throw new Error('The capability bundle response is invalid.');
      setBundles(response.bundles);
    } catch (err: unknown) {
      setBundlesError(getApiErrorMessage(err));
      setBundles([]);
    } finally {
      setBundlesLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated || !user) {
      setLoading(false);
      return;
    }
    fetchKeys();
    fetchCapabilities();
    fetchBundles();
  }, [authLoading, fetchBundles, fetchCapabilities, fetchKeys, isAuthenticated, user]);

  function startBundlePreview(mode: 'add' | 'replace', target: string, ids: string[]) {
    const bundle = bundles.find((item) => `${item.bundleId}@${item.version}` === selectedBundleKey);
    if (!bundle) return;
    setBundlePreviewError(null);
    setBundlePreview(createBundlePreview(mode, target, ids, bundle));
  }

  function applyBundlePreview(target: string, ids: string[], setter: (value: string[]) => void) {
    if (!bundlePreview) return;
    const invalidReason = validateBundlePreview(bundlePreview, target, ids, bundles, capabilities);
    if (invalidReason) { setBundlePreviewError(invalidReason); return; }
    const bundle = bundles.find((item) => item.bundleId === bundlePreview.bundleId && item.version === bundlePreview.version);
    const { removed } = getBundlePreviewDiff(bundlePreview);
    const removedDetails = removed.map((id) => {
      const capability = capabilities.find((item) => item.capabilityId === id);
      return `${capability?.label || capability?.functionSignature || 'Unavailable function'} (${id})`;
    });
    if (bundlePreview.mode === 'replace' && !confirm(`Replace the full selection with ${bundle?.label ?? bundlePreview.bundleId} v${bundlePreview.version}? This removes ${removed.length} existing grant${removed.length === 1 ? '' : 's'}${removedDetails.length ? `: ${removedDetails.join('; ')}` : ''}. This only changes the form; saving remains a separate step.`)) return;
    setter([...bundlePreview.ids]);
    setBundlePreview(null);
    setBundlePreviewError(null);
  }

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

  useEffect(() => {
    setBundlePreview(null);
    setBundlePreviewError(null);
  }, [editingKeyId]);

  useEffect(() => {
    setCapabilityResultLimit(30);
  }, [capabilitySearch, capabilityChainFilter, capabilityGroupFilter, capabilitySelectedOnly]);

  async function handleCreate() {
    if (hasReachedKeyLimit) {
      setActionError('Revoke a non-revoked API key before creating another one.');
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

    const spendLimits: { daily?: string; monthly?: string } = {};
    if (newKeyDailySpendLimit.trim()) spendLimits.daily = newKeyDailySpendLimit.trim();
    if (newKeyMonthlySpendLimit.trim()) spendLimits.monthly = newKeyMonthlySpendLimit.trim();

    setActionLoading(true);
    setActionError(null);
    try {
      const stepUpToken = getDashboardStepUpToken() ?? await requestStepUpToken(getToken);
      const result = await createApiKeyAuth(
        getToken,
        {
          name: trimmedName,
          ...(allowedIps.length > 0 ? { allowedIps } : {}),
          allowedCapabilityIds: newKeyAllowedCapabilityIds,
          ...(Object.keys(spendLimits).length > 0 ? { spendLimits } : {}),
          permissions: newKeyPermissions,
        },
        stepUpToken,
      );
      setNewRawKey(result.rawKey);
      setNewKeyExpiresAt(result.expiresAt);
      setNewKeyName('');
      setNewKeyAllowedIps('');
       setNewKeyAllowedCapabilityIds([]);
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
      const stepUpToken = getDashboardStepUpToken() ?? await requestStepUpToken(getToken);
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
        `Rotate ${occupiedKeySlots} non-revoked API key${occupiedKeySlots === 1 ? '' : 's'}? This revokes every non-revoked key (including frozen or expired), creates one replacement, and shows the new raw key only once. Frozen keys cannot be restored — save the new key securely.`,
      )
    ) {
      return;
    }
    setActionLoading(true);
    setActionError(null);
    try {
      const stepUpToken = getDashboardStepUpToken() ?? await requestStepUpToken(getToken);
      const result = await refreshApiKeyApi(getToken, stepUpToken);
      setNewRawKey(result.apiKey);
      await fetchKeys();
    } catch (err: unknown) {
      setActionError(getApiErrorMessage(err));
    } finally {
      setActionLoading(false);
    }
  }

  async function handleRevokeAll() {
    if (occupiedKeySlots === 0) return;
    if (
      !confirm(
        `Emergency revoke ${occupiedKeySlots} non-revoked API key${occupiedKeySlots === 1 ? '' : 's'}? This immediately stops all backend integrations (including frozen keys) and does not create a replacement.`,
      )
    ) {
      return;
    }
    setActionLoading(true);
    setActionError(null);
    try {
      const stepUpToken = getDashboardStepUpToken() ?? await requestStepUpToken(getToken);
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

  async function handleSaveCapabilities(key: ApiKeyRecord) {
    if (capabilitySaving) return;
    if (!confirm(`Update capabilities for ${key.name || key.displayPrefix}? An empty grant allows no catalog operations.`)) return;
    setCapabilitySaving(true);
    setCapabilityError(null);
    try {
      const stepUpToken = getDashboardStepUpToken() ?? await requestStepUpToken(getToken);
      const result = await updateApiKeyCapabilitiesAuth(getToken, key.id, editingCapabilityIds, stepUpToken);
      setKeys((current) => current.map((item) => item.id === result.id
        ? { ...item, allowedCapabilityIds: result.allowedCapabilityIds }
        : item));
      setEditingKeyId(null);
    } catch (err: unknown) {
      setCapabilityError(getApiErrorMessage(err));
    } finally {
      setCapabilitySaving(false);
    }
  }

  function toggleCapability(ids: string[], id: string, setter: (value: string[]) => void) {
    setter(ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id]);
  }

  function capabilityChoices(ids: string[], setter: (value: string[]) => void, target: string, disabled = false) {
    if (capabilitiesLoading) return <p className="text-sm text-brand-muted">Loading capability catalog…</p>;
    if (capabilitiesError) return <div className="flex items-center gap-3 text-sm text-red-700"><span>{capabilitiesError}</span><button type="button" onClick={fetchCapabilities} className="underline">Retry</button></div>;
    const visibleCapabilities = capabilities.filter((capability) => capability.status === 'active' || ids.includes(capability.capabilityId));
    const unknownIds = ids.filter((id) => !capabilities.some((capability) => capability.capabilityId === id));
    const query = capabilitySearch.trim().toLowerCase();
    const matches = visibleCapabilities.filter((capability) => {
      const searchable = [capability.label, capability.description, capability.protocol, capability.operation,
        capability.functionSignature, capability.contract, capability.capabilityId, String(capability.chainId)]
        .filter(Boolean).join(' ').toLowerCase();
      return (!query || searchable.includes(query)) &&
        (capabilityChainFilter === 'all' || String(capability.chainId) === capabilityChainFilter) &&
        (capabilityGroupFilter === 'all' || capabilityCategory(capability) === capabilityGroupFilter) &&
        (!capabilitySelectedOnly || ids.includes(capability.capabilityId));
    });
    const groups = capabilityGroupsForChain(visibleCapabilities, capabilityChainFilter);
    const chains = [...new Set(visibleCapabilities.map((capability) => capability.chainId))].sort((a, b) => a - b);
    const selectCapability = (id: string) => {
      if (ids.includes(id)) setter(ids.filter((value) => value !== id));
      else setter([...ids, id]);
    };
    const filtered = Boolean(query || capabilityChainFilter !== 'all' || capabilityGroupFilter !== 'all' || capabilitySelectedOnly);
     const selectedCapabilities = ids.map((id) => capabilities.find((item) => item.capabilityId === id));
     return <div className="space-y-3">
       <details className="rounded-lg border border-brand-border bg-white p-3">
         <summary className="cursor-pointer text-sm font-semibold text-brand-text">Quick setup with a bundle <span className="ml-2 text-xs font-normal text-brand-muted">Optional</span></summary>
         <div className="pt-3">
         <p className="text-xs leading-5 text-brand-muted">Bundles are starting points, not guaranteed workflows or asset support. Review changes before applying.</p>
        {bundlesLoading ? <p className="mt-2 text-xs text-brand-muted">Loading published bundles… Individual function selection is available meanwhile.</p> : bundlesError ? <p className="mt-2 text-xs text-amber-800">Bundles could not be loaded. Individual function selection is still available. <button type="button" onClick={fetchBundles} className="underline">Retry</button></p> : bundles.length === 0 ? <p className="mt-2 text-xs text-brand-muted">No bundles are currently published. You can still choose individual functions.</p> : <div className="mt-3 flex flex-wrap gap-2">
          <select aria-label="Choose capability bundle" value={selectedBundleKey} onChange={(event) => { setSelectedBundleKey(event.target.value); setBundlePreview(null); setBundlePreviewError(null); }} className="min-w-0 flex-1 rounded-lg border border-brand-border bg-white px-3 py-2 text-sm"><option value="">Choose a bundle</option>{bundles.map((bundle) => <option key={`${bundle.bundleId}@${bundle.version}`} value={`${bundle.bundleId}@${bundle.version}`}>{bundle.label} · v{bundle.version}{bundle.available ? '' : ' · unavailable'}</option>)}</select>
          <button type="button" disabled={disabled || !selectedBundleKey || !bundles.find((item) => `${item.bundleId}@${item.version}` === selectedBundleKey)?.available} onClick={() => startBundlePreview('add', target, ids)} className="rounded-full border border-brand-border px-3 py-2 text-xs font-semibold hover:border-brand-accent disabled:opacity-50">Add to selection</button>
          <button type="button" disabled={disabled || !selectedBundleKey || !bundles.find((item) => `${item.bundleId}@${item.version}` === selectedBundleKey)?.available} onClick={() => startBundlePreview('replace', target, ids)} className="rounded-full border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50">Replace selection</button>
        </div>}
        {selectedBundleKey && (() => { const bundle = bundles.find((item) => `${item.bundleId}@${item.version}` === selectedBundleKey); if (!bundle) return null; const memberUnavailable = !bundle.capabilityIds.every((id) => capabilities.some((capability) => capability.capabilityId === id && capability.status === 'active')); return <div className="mt-3 rounded-lg bg-brand-bg/70 p-3 text-xs leading-5">
          <p className="font-semibold text-brand-text">{bundle.label} · v{bundle.version} · {bundle.capabilityIds.length} exact function grants</p><p className="break-all font-mono text-[10px] text-brand-muted">{bundle.fingerprint}</p>
          <p className="mt-1 text-brand-muted">Chains: {bundle.chainIds.map((chain) => SUPPORTED_CHAINS.find((item) => item.id === chain)?.name ?? `Chain ${chain}`).join(', ')}</p>
          {(!bundle.available || memberUnavailable) && <p className="mt-2 font-semibold text-red-800">Unavailable: {bundle.unavailableCapabilityIds.join(', ') || 'one or more functions are missing or inactive in the current catalog'}. This bundle cannot be applied.</p>}
          {[...bundle.warnings, ...bundle.limitations].length > 0 && <ul className="mt-2 list-disc space-y-1 pl-4 text-amber-900">{[...bundle.warnings, ...bundle.limitations].map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul>}
          <details className="mt-2"><summary className="cursor-pointer font-semibold">Inspect all functions ({bundle.capabilityIds.length})</summary><ul className="mt-2 max-h-56 space-y-1 overflow-auto">{bundle.capabilityIds.map((id) => { const cap = capabilities.find((item) => item.capabilityId === id); return <li key={id} className="break-all">{cap ? `${cap.label} · ${cap.functionSignature || 'Contract call'} · ${cap.contract} · ${SUPPORTED_CHAINS.find((item) => item.id === cap.chainId)?.name ?? `Chain ${cap.chainId}`}` : id} <code className="text-[10px] text-brand-muted">{id}</code></li>; })}</ul></details>
        </div>; })()}
        {bundlePreview?.target === target && (() => { const bundle = bundles.find((item) => item.bundleId === bundlePreview.bundleId && item.version === bundlePreview.version); const { added, removed, unchanged } = getBundlePreviewDiff(bundlePreview); const invalidReason = validateBundlePreview(bundlePreview, target, ids, bundles, capabilities); const labelFor = (id: string) => { const capability = capabilities.find((item) => item.capabilityId === id); return capability ? `${capability.label || capability.functionSignature || id} · ${id}` : `Unavailable function · ${id}`; }; return <div role="region" aria-label="Bundle selection preview" className="mt-3 rounded-lg border border-brand-accent/40 bg-white p-3 text-xs leading-5"><p className="font-semibold text-brand-text">Preview {bundlePreview.mode === 'add' ? 'add' : 'replacement'} · {bundle?.label} v{bundlePreview.version}</p><p>{added.length} added · {removed.length} removed · {unchanged.length} unchanged · {bundlePreview.ids.length} selected functions</p>{[['Added', added], ['Removed', removed], ['Unchanged', unchanged]].map(([heading, values]) => <details key={heading as string} className="mt-2"><summary className="cursor-pointer font-semibold">{heading as string} ({(values as string[]).length})</summary><ul className="mt-1 max-h-40 space-y-1 overflow-auto">{(values as string[]).map((id) => <li key={id} className="break-all">{labelFor(id)}</li>)}</ul></details>)}{invalidReason && <p role="alert" className="mt-2 font-semibold text-red-800">{invalidReason}</p>}{bundlePreviewError && <p role="alert" className="mt-2 font-semibold text-red-800">{bundlePreviewError}</p>}<div className="mt-2 flex gap-2"><button type="button" disabled={disabled || Boolean(invalidReason)} onClick={() => applyBundlePreview(target, ids, setter)} className="rounded-full bg-brand-text px-3 py-1.5 font-semibold text-white disabled:opacity-50">Apply to form</button><button type="button" onClick={() => { setBundlePreview(null); setBundlePreviewError(null); }} className="rounded-full border border-brand-border px-3 py-1.5">Cancel</button></div></div>; })()}
         </div>
       </details>
       <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-brand-border bg-white px-3 py-2 text-sm"><button type="button" aria-expanded={selectedManagementOpen} onClick={() => setSelectedManagementOpen(!selectedManagementOpen)} className="font-semibold text-brand-text">Selected functions · {ids.length} <span className="ml-1 text-xs font-normal text-brand-muted">{selectedManagementOpen ? 'Hide list' : 'Manage list'}</span></button>{ids.length > 0 && <button type="button" disabled={disabled} onClick={() => setter([])} className="text-xs font-semibold text-brand-muted underline">Remove all</button>}</div>
       {selectedManagementOpen && <div className="max-h-64 space-y-2 overflow-auto rounded-lg border border-brand-border bg-white p-3">{ids.map((id, index) => { const capability = selectedCapabilities[index]; return <div key={id} className="flex min-w-0 items-start justify-between gap-3 border-b border-brand-border/60 pb-2 last:border-0"><span className="min-w-0"><span className="block font-semibold text-sm">{capability?.label ?? 'Unavailable capability'}</span><span className="block text-xs text-brand-muted">{capability ? `${SUPPORTED_CHAINS.find((chain) => chain.id === capability.chainId)?.name ?? `Chain ${capability.chainId}`} · ${capability.protocol || capability.operation || 'Function'}` : 'No longer in catalog'}</span><code className="block break-all text-[10px] text-brand-muted">{id}</code></span><button type="button" disabled={disabled} onClick={() => toggleCapability(ids, id, setter)} aria-label={`Remove ${capability?.label ?? 'unavailable capability'} ${id}`} className="shrink-0 rounded-full border border-brand-border px-2 py-1 text-xs hover:bg-brand-bg disabled:opacity-50">Remove</button></div>; })}</div>}
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
        <label className="relative block"><span className="sr-only">Search functions</span><Search aria-hidden="true" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-muted" /><input type="search" value={capabilitySearch} onChange={(event) => setCapabilitySearch(event.target.value)} placeholder="Search function, protocol, address or ID" className="w-full rounded-lg border border-brand-border bg-white py-2 pl-9 pr-3 text-sm focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent" /></label>
       <select aria-label="Filter by chain" value={capabilityChainFilter} onChange={(event) => { const nextChain = event.target.value; setCapabilityGroupFilter((group) => validCapabilityGroupForChain(group, visibleCapabilities, nextChain)); setCapabilityChainFilter(nextChain); }} className="rounded-lg border border-brand-border bg-white px-3 py-2 text-sm text-brand-text"><option value="all">All chains</option>{chains.map((chainId) => <option key={chainId} value={chainId}>{SUPPORTED_CHAINS.find((chain) => chain.id === chainId)?.name ?? `Chain ${chainId}`}</option>)}</select>
        <select aria-label="Filter by protocol or group" value={capabilityGroupFilter} onChange={(event) => setCapabilityGroupFilter(event.target.value)} className="rounded-lg border border-brand-border bg-white px-3 py-2 text-sm text-brand-text"><option value="all">All protocols / groups</option>{groups.map((group) => <option key={group} value={group}>{group}</option>)}</select>
      </div>
       <div className="flex flex-wrap items-center justify-end gap-3 text-xs text-brand-muted"><label className="inline-flex items-center gap-2"><input type="checkbox" checked={capabilitySelectedOnly} onChange={(event) => setCapabilitySelectedOnly(event.target.checked)} className="h-4 w-4 rounded border-brand-border text-brand-accent focus:ring-brand-accent" />Selected only</label>{filtered && <button type="button" onClick={() => { setCapabilitySearch(''); setCapabilityChainFilter('all'); setCapabilityGroupFilter('all'); setCapabilitySelectedOnly(false); }} className="font-semibold text-brand-text underline underline-offset-2">Clear filters</button>}</div>
      {capabilities.length === 0 && <p className="text-sm leading-6 text-brand-muted">No capabilities are available from the catalog right now. New keys will have no catalog access until capabilities are published.</p>}
       {matches.length === 0 && visibleCapabilities.length > 0 && <p className="rounded-lg border border-brand-border bg-white p-4 text-sm text-brand-muted">No functions match these filters.</p>}
         <p className="text-xs text-brand-muted">Showing {Math.min(matches.length, capabilityResultLimit)} of {matches.length} matching functions</p>
        {matches.slice(0, capabilityResultLimit).map((capability) => {
      const selected = ids.includes(capability.capabilityId);
       return <div key={capability.capabilityId} className={`flex gap-3 rounded-lg border border-brand-border bg-white p-3 text-sm ${capability.status === 'active' ? 'hover:border-brand-accent' : 'opacity-70'}`}>
         <input id={`cap-${target}-${capability.capabilityId}`} type="checkbox" checked={selected} disabled={disabled || (capability.status !== 'active' && !selected)} onChange={() => selectCapability(capability.capabilityId)} className="mt-1 h-4 w-4 shrink-0 rounded border-brand-border text-brand-accent focus:ring-brand-accent" />
         <div className="min-w-0 flex-1"><label htmlFor={`cap-${target}-${capability.capabilityId}`} className="block cursor-pointer font-semibold text-brand-text">{capability.label}<span className="ml-2 text-[10px] font-bold uppercase text-brand-muted">{capability.status}</span></label>
           <span className="block text-xs leading-5 text-brand-muted">{capability.description}</span>
           <span className="block text-xs text-brand-muted">{SUPPORTED_CHAINS.find((chain) => chain.id === capability.chainId)?.name ?? `Chain ${capability.chainId}`} · {capability.protocol || capability.operation || 'Function'}</span>
          {(capability.protocol || capability.operation) && <span className="mt-1 block text-xs text-brand-muted">{[capability.protocol, capability.operation].filter(Boolean).join(' · ')}</span>}
           <details className="mt-1 text-xs"><summary className="w-fit cursor-pointer font-semibold text-brand-muted">Technical details</summary><div className="mt-1 space-y-1"><span className="block break-all font-mono">{capability.functionSignature || 'Contract call'} · {capability.contract} · {capability.capabilityId}</span>{capability.policy && <span className="block">Policy: {capability.policy.ref} v{capability.policy.version}</span>}{capability.provenance && <span className="block break-all">Source: {capability.provenance.sourceRef} · {capability.provenance.status}{capability.provenance.verifiedAt ? ` · ${capability.provenance.verifiedAt}` : ''}</span>}</div></details>
          {((capability.warnings ?? []).length > 0 || FUNCTION_WARNINGS[capability.operation?.toLowerCase() ?? ''] || FUNCTION_WARNINGS[capability.functionSignature?.split('(')[0] ?? '']) && <span className="mt-2 block rounded-md bg-amber-50 px-2.5 py-2 text-xs leading-5 text-amber-900">{[...(capability.warnings ?? []), FUNCTION_WARNINGS[capability.operation?.toLowerCase() ?? ''] ?? FUNCTION_WARNINGS[capability.functionSignature?.split('(')[0] ?? '']].filter(Boolean).join(' ')}</span>}
         </div>
       </div>;
       })}
       {matches.length > capabilityResultLimit && <button type="button" onClick={() => setCapabilityResultLimit((limit) => limit + 30)} className="w-full rounded-lg border border-brand-border bg-white px-3 py-2 text-sm font-semibold text-brand-text hover:border-brand-accent">Show 30 more ({matches.length - capabilityResultLimit} remaining)</button>}
      {unknownIds.map((id) => <div key={id} className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm">
        <input type="checkbox" checked disabled aria-label={`Unavailable grant ${id}`} className="mt-1 h-4 w-4 rounded border-brand-border text-brand-accent focus:ring-brand-accent" />
        <span className="min-w-0"><span className="block font-semibold text-brand-text">Unavailable capability</span><code className="block break-all text-xs text-brand-muted">{id}</code><button type="button" disabled={disabled} onClick={() => toggleCapability(ids, id, setter)} className="mt-1 text-xs font-semibold text-amber-800 underline disabled:opacity-50">Remove grant</button></span>
      </div>)}
      {ids.length > 0 && <button type="button" disabled={disabled} onClick={() => setter([])} className="mt-1 rounded-full border border-brand-border bg-white px-3 py-1.5 text-xs font-semibold text-brand-text hover:border-brand-accent disabled:opacity-50">Clear all grants</button>}
    </div>;
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
              <span className="font-semibold text-brand-text">{occupiedKeySlots}</span> of{' '}
              <span className="font-semibold text-brand-text">{MAX_ACTIVE_API_KEYS}</span> key slots used
              (non-revoked, including frozen or expired).{' '}
              <span className="font-semibold text-brand-text">{activeKeyCount}</span> currently{' '}
              {activeKeyCount === 1 ? 'is' : 'are'} Active and usable.{' '}
              {hasReachedKeyLimit
                ? 'Revoke a non-revoked key before creating another one.'
                : `${remainingKeySlots} ${remainingKeySlots === 1 ? 'slot remains' : 'slots remain'}.`}
            </>
          )}
        </div>
        <div className="mt-6 space-y-5">
          <div className="grid gap-5 md:grid-cols-2 rounded-xl border border-brand-border bg-white p-4">
          <div className="space-y-2">
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
              Use a unique active name. The key is shown once after creation; store it in your backend secret store.
            </p>
          </div>
          <details className="space-y-2 md:col-span-2 rounded-lg border border-brand-border bg-brand-bg/50 p-3">
            <summary className="cursor-pointer text-sm font-semibold text-brand-text">Restrict by IP <span className="font-normal text-brand-muted">· optional</span></summary>
            <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted block">
              IP allowlist
            </label>
            <textarea
              rows={3}
              placeholder="192.0.2.10, 203.0.113.0/24"
              value={newKeyAllowedIps}
              onChange={(e) => setNewKeyAllowedIps(e.target.value)}
              className="w-full rounded-lg border border-brand-border px-4 py-2.5 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent placeholder:text-brand-muted bg-white shadow-sm transition-colors"
            />
            <p className="text-xs leading-5 text-brand-muted">
              Only allow requests from trusted backend IPs. Blank allows any IP; 0.0.0.0/0 allows all IPv4 addresses.
            </p>
          </details>
          </div>
          <section className="space-y-3 rounded-xl border border-brand-border bg-brand-bg/40 p-4">
            <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-sm font-semibold text-brand-text">DeFi function access</p><p className="mt-1 text-xs leading-5 text-brand-muted">Choose exact chain, contract and function grants. No selection denies catalog operations. Signing and broad multicall commands are not available here.</p></div><span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-brand-muted">Separate from API endpoints</span></div>
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-950">You choose the authority for this key. A grant does not guarantee safe protocol limits or prices: your caller chooses assets, amounts, recipients, native value, borrow risk, minimum output and deadlines. ERC-20 approval calls can approve any spender, for any amount including unlimited, even when no action grant is selected. Review your caller and each transaction.</div>
            {capabilityChoices(newKeyAllowedCapabilityIds, setNewKeyAllowedCapabilityIds, 'create')}
          </section>
          <details className="rounded-xl border border-brand-border bg-white p-4">
            <summary className="cursor-pointer text-sm font-semibold text-brand-text">Set native-token spend limits <span className="font-normal text-brand-muted">· optional</span></summary>
          <div className="mt-4 grid gap-5 sm:grid-cols-2">
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
          </details>
          <section className="space-y-3 rounded-xl border border-brand-border bg-brand-bg/40 p-4">
            <div>
              <p className="text-sm font-semibold text-brand-text">API endpoint access</p>
              <p className="mt-1 text-xs leading-5 text-brand-muted">
                Controls which API endpoints this key can call. Keep privileged EOA execution off unless reviewed.
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
          </section>
          <div>
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
        <div className="p-5 border-b border-brand-border sm:p-7">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="text-xl font-bold font-serif text-brand-text">Your Keys</h2>
              <p className="mt-1 text-xs text-brand-muted">
                Status priority is revoked → frozen → expired → active. Active keys sort by soonest expiry, then
                most recent use; frozen keys surface freeze time and secure recovery guidance.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
              <button
                type="button"
                onClick={handleRevokeAll}
                disabled={loading || actionLoading || occupiedKeySlots === 0}
                className="inline-flex items-center justify-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-4 py-1.5 text-xs font-semibold text-red-700 transition-all hover:border-red-300 hover:bg-red-100 disabled:opacity-50"
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                Revoke all
              </button>
              <div className="inline-flex max-w-full flex-wrap rounded-full border border-brand-border bg-brand-bg p-1">
                {KEY_STATUS_FILTERS.map((filter) => (
                  <button
                    key={filter.value}
                    type="button"
                    onClick={() => setKeyStatusFilter(filter.value)}
                    className={`rounded-full px-2.5 py-1 text-xs font-semibold transition-colors sm:px-3 ${
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
              <p className="leading-5">
                Showing {visibleKeys.length} of {keys.length} keys · {activeKeyCount} active
                {frozenKeyCount > 0 ? ` · ${frozenKeyCount} frozen` : ''}
                {expiredKeyCount > 0 ? ` · ${expiredKeyCount} expired` : ''}
                {' · '}
                {revokedKeyCount} revoked
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
            <div
              className="hidden grid-cols-[minmax(128px,0.9fr)_88px_minmax(96px,0.7fr)_minmax(300px,2.4fr)_minmax(78px,0.55fr)_minmax(88px,0.6fr)_minmax(78px,0.55fr)_36px] items-center gap-3 px-5 py-3 text-[11px] font-bold uppercase tracking-widest text-brand-muted xl:grid xl:px-7"
            >
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
              const lifecycleStatus = getApiKeyLifecycleStatus(key);
              const statusLabel = getApiKeyLifecycleLabel(lifecycleStatus);
              const lastUsed = getRelativeDateSummary(key.lastUsedAt, 'Never');
              const created = getRelativeDateSummary(key.createdAt, 'Unknown');
              const expiry = getKeyExpirySummary(key.expiresAt);
              const frozenAtSummary = key.frozenAt
                ? getRelativeDateSummary(key.frozenAt, 'Unknown')
                : null;
              const frozenReasonLabel =
                lifecycleStatus === 'frozen' ? formatApiKeyFrozenReason(key.frozenReason) : null;
              const allowedCapabilityIds = key.allowedCapabilityIds ?? [];
              const canRevoke = lifecycleStatus !== 'revoked';

              return (
                <div
                  key={key.id}
                  className={`min-w-0 transition-colors hover:bg-brand-surface ${
                    lifecycleStatus === 'frozen' ? 'bg-amber-50/40' : ''
                  }`}
                >
                  <div className="grid min-w-0 gap-3 px-5 py-4 sm:grid-cols-2 sm:gap-x-4 xl:grid-cols-[minmax(128px,0.9fr)_88px_minmax(96px,0.7fr)_minmax(300px,2.4fr)_minmax(78px,0.55fr)_minmax(88px,0.6fr)_minmax(78px,0.55fr)_36px] xl:items-center xl:gap-3 xl:px-7">
                    <span className="flex min-w-0 items-center gap-2 font-mono text-sm text-brand-text sm:col-span-2 xl:col-span-1">
                      <span className="min-w-0 truncate">{key.displayPrefix}</span>
                      <CopyButton
                        text={key.displayPrefix}
                        className="h-7 w-7 shrink-0 border-brand-border/80 bg-white text-brand-muted hover:text-brand-accent"
                      />
                    </span>
                    <span
                      className={`w-fit rounded-full px-2.5 py-0.5 text-xs font-semibold ${getApiKeyLifecycleBadgeClass(lifecycleStatus)}`}
                    >
                      {statusLabel}
                    </span>
                    <span className="min-w-0 truncate text-sm text-brand-muted">
                      <span className="font-semibold text-brand-text xl:hidden">Name: </span>
                      {key.name || '—'}
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5 overflow-x-auto whitespace-nowrap text-[11px] font-semibold text-brand-muted sm:col-span-2 xl:col-span-1">
                      <span className="shrink-0 font-semibold text-brand-text xl:hidden">Permissions: </span>
                      {key.permissions.canReadTransactionStatus && <span className="shrink-0 rounded-full bg-brand-bg px-2 py-0.5">status</span>}
                      {key.permissions.canSign && <span className="shrink-0 rounded-full bg-brand-bg px-2 py-0.5">sign</span>}
                      {key.permissions.canSendTransaction && <span className="shrink-0 rounded-full bg-brand-bg px-2 py-0.5">send</span>}
                      {key.permissions.canUseEoaExecution && <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-amber-800">eoa</span>}
                      {!key.permissions.canReadTransactionStatus &&
                        !key.permissions.canSign &&
                        !key.permissions.canSendTransaction &&
                        !key.permissions.canUseEoaExecution && <span className="shrink-0">none</span>}
                      <span className={`shrink-0 rounded-full px-1.5 py-0.5 ${allowedCapabilityIds.length ? 'bg-blue-50 text-blue-700' : 'bg-brand-bg text-brand-muted'}`}>
                        {allowedCapabilityIds.length} {allowedCapabilityIds.length === 1 ? 'capability' : 'capabilities'}
                      </span>
                      {(key.dailySpendLimit || key.monthlySpendLimit) && (
                        <>
                        {key.dailySpendLimit && (
                          <span className="shrink-0 rounded-full bg-amber-50 px-1.5 py-0.5 text-amber-700">
                            Daily: {BigInt(key.dailySpendLimit) >= 1_000_000_000_000_000_000n
                              ? `${(Number(BigInt(key.dailySpendLimit) / 1_000_000_000_000_000_000n)).toLocaleString()} ETH`
                              : `${Number(key.dailySpendLimit).toLocaleString()} wei`}
                          </span>
                        )}
                        {key.monthlySpendLimit && (
                          <span className="shrink-0 rounded-full bg-amber-50 px-1.5 py-0.5 text-amber-700">
                            Monthly: {BigInt(key.monthlySpendLimit) >= 1_000_000_000_000_000_000n
                              ? `${(Number(BigInt(key.monthlySpendLimit) / 1_000_000_000_000_000_000n)).toLocaleString()} ETH`
                              : `${Number(key.monthlySpendLimit).toLocaleString()} wei`}
                          </span>
                        )}
                        </>
                      )}
                    </span>
                    <span className={`text-xs ${lastUsed.tone}`}>
                      <span className="font-semibold text-brand-text xl:hidden">Last used: </span>
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
                      <span className="font-semibold text-brand-text xl:hidden">Expires: </span>
                      <span className="font-semibold">{expiry.label}</span>
                      <span className="block text-[11px] opacity-80">{expiry.detail}</span>
                    </span>
                    <span className={`text-xs ${created.tone}`}>
                      <span className="font-semibold text-brand-text xl:hidden">Created: </span>
                      <span className="font-semibold">{created.label}</span>
                      {created.detail && <span className="block text-[11px] opacity-80">{created.detail}</span>}
                    </span>
                    {canRevoke ? (
                      <button
                        onClick={() => handleRevoke(key)}
                        disabled={actionLoading}
                        aria-label={`Revoke API key ${key.name || key.displayPrefix}`}
                        className="w-fit rounded-full border border-red-200 bg-red-50 p-1.5 text-red-600 hover:bg-red-100 hover:border-red-300 transition-colors disabled:opacity-50 xl:justify-self-end"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    ) : (
                      <span className="hidden h-7 w-7 xl:block" />
                    )}
                  </div>
                  {editingKeyId === key.id && (
                    <div className="mx-5 mb-4 space-y-3 rounded-xl border border-brand-border bg-brand-bg/60 p-4 sm:mx-7">
                        <p className="text-sm font-semibold text-brand-text">DeFi function access</p>
                         <p className="text-xs leading-5 text-brand-muted">Choose exact functions. Saving replaces all current grants.</p>
                        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-950">Your caller chooses recipients, assets, amounts and native value (only payable functions accept native value), as well as protocol-specific minimum output and deadlines. The platform does not financially validate these choices; review your caller and each transaction.</p>
                      {capabilityError && <p role="alert" className="text-sm text-red-700">{capabilityError}</p>}
                      {capabilityChoices(editingCapabilityIds, setEditingCapabilityIds, `key:${key.id}`, capabilitySaving)}
                      <div className="flex flex-wrap gap-2"><button type="button" onClick={() => handleSaveCapabilities(key)} disabled={capabilitySaving || capabilitiesLoading || Boolean(capabilitiesError)} className="inline-flex items-center gap-2 rounded-full bg-brand-text px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">{capabilitySaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Save grants</button><button type="button" onClick={() => { setEditingKeyId(null); setCapabilityError(null); }} disabled={capabilitySaving} className="rounded-full border border-brand-border bg-white px-4 py-2 text-xs font-semibold text-brand-text">Cancel</button></div>
                    </div>
                  )}
                  {editingKeyId !== key.id && canRevoke && (
                    <button type="button" onClick={() => { setEditingKeyId(key.id); setEditingCapabilityIds(allowedCapabilityIds); setCapabilityError(null); }} disabled={actionLoading || capabilitySaving} className="mx-5 mb-4 inline-flex items-center gap-2 rounded-full border border-brand-border bg-white px-3 py-1.5 text-xs font-semibold text-brand-text hover:border-brand-accent sm:mx-7"><ShieldCheck className="h-3.5 w-3.5" />Edit capabilities ({allowedCapabilityIds.length})</button>
                  )}
                  {lifecycleStatus === 'frozen' && (
                    <div className="mx-5 mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900 sm:mx-5 xl:mx-7">
                      <p className="font-semibold text-amber-950">
                        Frozen
                        {frozenAtSummary
                          ? ` · ${frozenAtSummary.label}${frozenAtSummary.detail ? ` (${frozenAtSummary.detail})` : ''}`
                          : ''}
                      </p>
                      <p className="mt-1">{frozenReasonLabel}</p>
                      <p className="mt-2 text-amber-800">
                        This key cannot call the API and cannot be unfrozen in place. After MFA step-up, create a new
                        key or use Advanced key rotation, then update your backend secret store. Never reuse a frozen
                        raw key.
                      </p>
                    </div>
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
              Rotate all keys only if you believe existing keys were exposed or frozen. This revokes every non-revoked
              key (including frozen or expired) and creates one replacement. Frozen keys cannot be restored.
            </p>
            <p>
              The replacement raw key is shown once. Copy it into your backend secret store before deploying, then
              remove the old keys from every environment.
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
