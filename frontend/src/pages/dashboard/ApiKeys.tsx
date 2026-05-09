import { useCallback, useEffect, useState } from 'react';
import { useUser } from '@openfort/react';
import { AlertTriangle, Plus, RotateCcw, Trash2, Loader2, X } from 'lucide-react';
import { CopyButton } from '@/components/CopyButton';
import { DashboardPage, DashboardCard } from './components/DashboardPage';
import {
  listApiKeysAuth,
  createApiKeyAuth,
  revokeApiKeyAuth,
  refreshApiKey as refreshApiKeyApi,
  getApiErrorMessage,
  type ApiKeyRecord,
} from '@/lib/api';

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
  const [newRawKey, setNewRawKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sortedKeys = [...keys].sort((a, b) => Number(a.revoked) - Number(b.revoked));

  const fetchKeys = useCallback(async () => {
    try {
      const data = await listApiKeysAuth(getToken);
      setKeys(data);
    } catch (err: unknown) {
      setError(getApiErrorMessage(err));
    } finally {
      setLoading(false);
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

  async function handleCreate() {
    const trimmedName = newKeyName.trim();
    if (!trimmedName) {
      setError('Enter a unique name for this API key.');
      return;
    }

    setActionLoading(true);
    setError(null);
    try {
      const result = await createApiKeyAuth(getToken, trimmedName);
      setNewRawKey(result.rawKey);
      setNewKeyName('');
      await fetchKeys();
    } catch (err: unknown) {
      setError(getApiErrorMessage(err));
    } finally {
      setActionLoading(false);
    }
  }

  async function handleRevoke(id: string) {
    if (!confirm('Revoke this API key? This cannot be undone.')) return;
    setActionLoading(true);
    try {
      await revokeApiKeyAuth(getToken, id);
      await fetchKeys();
    } catch (err: unknown) {
      setError(getApiErrorMessage(err));
    } finally {
      setActionLoading(false);
    }
  }

  async function handleRefresh() {
    if (!confirm('This will revoke ALL existing keys and create a new one.')) return;
    setActionLoading(true);
    setError(null);
    try {
      const result = await refreshApiKeyApi(getToken);
      setNewRawKey(result.apiKey);
      await fetchKeys();
    } catch (err: unknown) {
      setError(getApiErrorMessage(err));
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <DashboardPage
      title="API Keys"
      description="Create keys your backend uses to submit transactions through your authorized EOA."
    >
      {error && (
        <div className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800 shadow-sm">
          <AlertTriangle className="h-5 w-5 shrink-0 text-red-600" />
          {error}
        </div>
      )}

      {newRawKey && (
        <div className="relative rounded-2xl border border-amber-200 bg-amber-50 p-5 pr-14 shadow-sm">
          <button
            onClick={() => setNewRawKey(null)}
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
        description="Name the app or environment that will use this key. You can revoke individual keys anytime."
      >
        <div className="mt-6 flex flex-col gap-5 lg:flex-row lg:items-end">
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
          </div>
          <div>
            <button
              onClick={handleCreate}
              disabled={actionLoading || !newKeyName.trim()}
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
          <h2 className="text-xl font-bold font-serif text-brand-text">Your Keys</h2>
        </div>
        
        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-brand-accent" />
          </div>
        ) : keys.length === 0 ? (
          <div className="px-7 py-12 text-center">
            <p className="text-base font-semibold text-brand-text">Create your first API key</p>
            <p className="mt-2 text-sm text-brand-muted">
              After your EOA is authorized, this key authenticates backend transaction requests.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-brand-border">
            <div className="hidden grid-cols-[140px_84px_minmax(180px,1fr)_100px_110px_36px] items-center gap-4 px-7 py-3 text-[11px] font-bold uppercase tracking-widest text-brand-muted md:grid">
              <span>Key</span>
              <span>Status</span>
              <span>Name</span>
              <span>Last Used</span>
              <span>Created</span>
              <span className="sr-only">Actions</span>
            </div>
            {sortedKeys.map((key) => (
              <div key={key.id} className="grid gap-3 px-7 py-4 transition-colors hover:bg-brand-surface md:grid-cols-[140px_84px_minmax(180px,1fr)_100px_110px_36px] md:items-center md:gap-4">
                <span className="font-mono text-sm text-brand-text">{key.displayPrefix}</span>
                <span className={`w-fit rounded-full px-2.5 py-0.5 text-xs font-semibold ${key.revoked ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                    {key.revoked ? 'Revoked' : 'Active'}
                </span>
                <span className="min-w-0 truncate text-sm text-brand-muted">
                  <span className="font-semibold text-brand-text md:hidden">Name: </span>
                  {key.name || '—'}
                </span>
                <span className="text-xs text-brand-muted">
                  <span className="font-semibold text-brand-text md:hidden">Last used: </span>
                  {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : 'Never'}
                </span>
                <span className="text-xs text-brand-muted">
                  <span className="font-semibold text-brand-text md:hidden">Created: </span>
                  {new Date(key.createdAt).toLocaleDateString()}
                </span>
                {!key.revoked ? (
                  <button
                    onClick={() => handleRevoke(key.id)}
                    disabled={actionLoading}
                    className="rounded-full border border-red-200 bg-red-50 p-1.5 text-red-600 hover:bg-red-100 hover:border-red-300 transition-colors disabled:opacity-50 md:justify-self-end"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <span className="hidden h-7 w-7 md:block" />
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <DashboardCard title="Quick Start">
        <div className="mt-5">
          <pre className="rounded-xl bg-brand-text p-5 text-sm text-brand-bg font-mono overflow-x-auto shadow-sm">
{`curl -X POST ${window.location.origin}/api/v1/transactions/send \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "chainId": 84532,
    "idempotencyKey": "order-abc-123",
    "interactions": [{
      "to": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "data": "0xa9059cbb0000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000000f4240",
      "value": "0"
    }]
  }'`}
          </pre>
          <p className="mt-3 text-sm leading-6 text-brand-muted">
            Replace the calldata with your ABI-encoded contract call. Keep API keys on your backend; do not ship them in browser code.
          </p>
        </div>
      </DashboardCard>

      <details className="rounded-2xl border border-red-200 bg-red-50 p-7 shadow-sm">
        <summary className="cursor-pointer select-none text-xl font-bold font-serif text-brand-text">
          Advanced key rotation
        </summary>
        <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-2xl text-sm text-red-800">
            Rotate all keys only if you believe existing keys were exposed. This revokes every active key and creates one replacement.
          </p>
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
