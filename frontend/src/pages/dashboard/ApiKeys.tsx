import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { AlertTriangle, Plus, RotateCcw, Trash2, Loader2, X } from 'lucide-react';
import { CopyButton } from '@/components/CopyButton';
import {
  listApiKeysAuth,
  createApiKeyAuth,
  revokeApiKeyAuth,
  refreshApiKey as refreshApiKeyApi,
  getApiErrorMessage,
  type ApiKeyRecord,
} from '@/lib/api';

const SUPPORTED_CHAINS = [
  { id: 84532, name: 'Base Sepolia' },
  { id: 8453, name: 'Base' },
  { id: 1, name: 'Ethereum' },
  { id: 11155111, name: 'Ethereum Sepolia' },
  { id: 137, name: 'Polygon' },
  { id: 80002, name: 'Polygon Amoy' },
];

const DEFAULT_ALLOWED_CHAINS = [84532];

function formatChains(chainIds: number[]) {
  return chainIds
    .map((chainId) => SUPPORTED_CHAINS.find((chain) => chain.id === chainId)?.name || String(chainId))
    .join(', ');
}

export default function ApiKeysPage() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [selectedChains, setSelectedChains] = useState<number[]>(DEFAULT_ALLOWED_CHAINS);
  const [newRawKey, setNewRawKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sortedKeys = [...keys].sort((a, b) => Number(a.revoked) - Number(b.revoked));

  async function fetchKeys() {
    try {
      const data = await listApiKeysAuth(getToken);
      setKeys(data);
    } catch (err: unknown) {
      setError(getApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (isLoaded && isSignedIn) {
      fetchKeys();
    }
  }, [isLoaded, isSignedIn]);

  async function handleCreate() {
    const trimmedName = newKeyName.trim();
    if (!trimmedName) {
      setError('Enter a unique name for this API key.');
      return;
    }

    if (selectedChains.length === 0) {
      setError('Select at least one chain for this API key.');
      return;
    }

    setActionLoading(true);
    setError(null);
    try {
      const result = await createApiKeyAuth(getToken, trimmedName, selectedChains);
      setNewRawKey(result.rawKey);
      setNewKeyName('');
      setSelectedChains(DEFAULT_ALLOWED_CHAINS);
      await fetchKeys();
    } catch (err: unknown) {
      setError(getApiErrorMessage(err));
    } finally {
      setActionLoading(false);
    }
  }

  function handleToggleChain(chainId: number) {
    setSelectedChains((current) =>
      current.includes(chainId) ? current.filter((id) => id !== chainId) : [...current, chainId],
    );
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
    <div className="mx-auto max-w-6xl space-y-10 pb-16">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between border-b border-brand-border pb-6 gap-4">
        <div>
          <h1 className="text-3xl font-bold font-serif text-brand-text">API Keys</h1>
          <p className="mt-2 text-sm text-brand-muted">
            Manage authentication keys for programmatic access.
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={actionLoading}
          className="flex items-center gap-1.5 rounded-full border border-brand-border bg-white px-5 py-2 text-xs font-semibold text-brand-text hover:border-brand-accent hover:text-brand-accent hover:shadow-sm transition-all disabled:opacity-50"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Rotate All Keys
        </button>
      </div>

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
            New API key created — save it now (shown only once):
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="flex-1 break-all rounded-xl bg-amber-100/50 border border-amber-200/50 px-4 py-3 font-mono text-sm text-amber-900 shadow-sm">
              {newRawKey}
            </code>
            <CopyButton text={newRawKey} className="shrink-0 border-amber-300 text-amber-600 hover:bg-amber-100" />
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-brand-border bg-white p-7 shadow-xl relative overflow-hidden ring-1 ring-black/5">
        <div className="absolute top-0 left-0 w-full h-1.5 bg-brand-text" />
        <h2 className="text-xl font-bold font-serif text-brand-text">Create New Key</h2>
        <div className="mt-6 flex flex-col gap-5 lg:flex-row lg:items-start">
          <div className="space-y-2 lg:w-1/3">
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
          <div className="space-y-2 lg:flex-1">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted block">Allowed Chains</label>
            </div>
            <div className="flex flex-wrap gap-2">
              {SUPPORTED_CHAINS.map((chain) => {
                const isSelected = selectedChains.includes(chain.id);
                return (
                  <button
                    type="button"
                    key={chain.id}
                    onClick={() => handleToggleChain(chain.id)}
                    className={`px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-all duration-200 ${
                      isSelected
                        ? 'bg-brand-text text-white border-brand-text shadow-md ring-2 ring-brand-text/20 ring-offset-1'
                        : 'bg-brand-surface/30 text-brand-text border-brand-border hover:border-brand-accent hover:bg-white hover:shadow-sm'
                    }`}
                  >
                    {chain.name}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-brand-muted pt-1">API requests using this key will be limited to selected chains.</p>
          </div>
          <div className="pt-6 lg:pt-0 lg:mt-7">
            <button
              onClick={handleCreate}
              disabled={actionLoading || selectedChains.length === 0 || !newKeyName.trim()}
              className="flex items-center justify-center gap-2 w-full rounded-full bg-brand-text px-8 py-2.5 text-sm font-semibold text-white shadow-lg hover:bg-brand-text/90 hover:shadow-xl hover:-translate-y-0.5 transition-all disabled:opacity-50 lg:w-auto"
            >
              <Plus className="h-4 w-4" />
              Create Key
            </button>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-brand-border bg-white shadow-xl relative overflow-hidden ring-1 ring-black/5">
        <div className="p-7 border-b border-brand-border">
          <h2 className="text-xl font-bold font-serif text-brand-text">Your Keys</h2>
        </div>
        
        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-brand-accent" />
          </div>
        ) : keys.length === 0 ? (
          <p className="px-7 py-12 text-center text-sm text-brand-muted">No API keys yet.</p>
        ) : (
          <div className="divide-y divide-brand-border">
            <div className="hidden grid-cols-[140px_84px_minmax(120px,1fr)_minmax(180px,1.4fr)_100px_110px_36px] items-center gap-4 px-7 py-3 text-[11px] font-bold uppercase tracking-widest text-brand-muted md:grid">
              <span>Key</span>
              <span>Status</span>
              <span>Name</span>
              <span>Chains</span>
              <span>Last Used</span>
              <span>Created</span>
              <span className="sr-only">Actions</span>
            </div>
            {sortedKeys.map((key) => (
              <div key={key.id} className="grid gap-3 px-7 py-4 transition-colors hover:bg-brand-surface md:grid-cols-[140px_84px_minmax(120px,1fr)_minmax(180px,1.4fr)_100px_110px_36px] md:items-center md:gap-4">
                <span className="font-mono text-sm text-brand-text">{key.keyPrefix.slice(0, 11)}...</span>
                <span className={`w-fit rounded-full px-2.5 py-0.5 text-xs font-semibold ${key.revoked ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                    {key.revoked ? 'Revoked' : 'Active'}
                </span>
                <span className="min-w-0 truncate text-sm text-brand-muted">
                  <span className="font-semibold text-brand-text md:hidden">Name: </span>
                  {key.name || '—'}
                </span>
                <span className="min-w-0 truncate text-xs text-brand-muted">
                  <span className="font-semibold text-brand-text md:hidden">Chains: </span>
                  {key.allowedChains?.length ? formatChains(key.allowedChains) : '—'}
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

      <div className="rounded-2xl border border-brand-border bg-white p-7 shadow-xl relative overflow-hidden ring-1 ring-black/5">
        <h2 className="text-xl font-bold font-serif text-brand-text">Quick Start</h2>
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
      "data": "0xa9059cbb...",
      "value": "0"
    }]
  }'`}
          </pre>
        </div>
      </div>
    </div>
  );
}
