import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import {
  listApiKeysAuth,
  createApiKeyAuth,
  revokeApiKeyAuth,
  refreshApiKey as refreshApiKeyApi,
} from '@/lib/api';

interface ApiKeyRecord {
  id: string;
  keyPrefix: string;
  name: string | null;
  revoked: boolean;
  expiresAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export default function ApiKeysPage() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [newRawKey, setNewRawKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchKeys() {
    try {
      const data = await listApiKeysAuth(getToken);
      setKeys(data);
    } catch (err: any) {
      setError(err.message);
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
    setActionLoading(true);
    setError(null);
    try {
      const result = await createApiKeyAuth(getToken, newKeyName || undefined);
      setNewRawKey(result.rawKey);
      setNewKeyName('');
      await fetchKeys();
    } catch (err: any) {
      setError(err.message);
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
    } catch (err: any) {
      setError(err.message);
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
    } catch (err: any) {
      setError(err.message);
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
          className="rounded-full border border-brand-border bg-white px-5 py-2 text-xs font-semibold text-brand-text hover:border-brand-accent hover:text-brand-accent hover:shadow-sm transition-all disabled:opacity-50"
        >
          Rotate All Keys
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800 shadow-sm">
          <svg className="h-5 w-5 shrink-0 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          {error}
        </div>
      )}

      {newRawKey && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 shadow-sm">
          <p className="text-sm font-medium text-amber-800">
            New API key created — save it now (shown only once):
          </p>
          <code className="mt-3 block break-all rounded-xl bg-amber-100/50 border border-amber-200/50 px-4 py-3 font-mono text-sm text-amber-900 shadow-sm">
            {newRawKey}
          </code>
          <div className="mt-4">
            <button
              onClick={() => setNewRawKey(null)}
              className="text-xs font-semibold text-amber-600 underline hover:text-amber-800 transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-brand-border bg-white p-7 shadow-xl relative overflow-hidden ring-1 ring-black/5">
        <div className="absolute top-0 left-0 w-full h-1.5 bg-brand-text" />
        <h2 className="text-xl font-bold font-serif text-brand-text">Create New Key</h2>
        <div className="mt-6 flex flex-col sm:flex-row gap-4">
          <div className="flex-1 space-y-2">
            <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted block">Key Name</label>
            <input
              type="text"
              placeholder="e.g. Production Backend"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              className="w-full rounded-lg border border-brand-border px-4 py-2.5 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent placeholder:text-brand-muted bg-white shadow-sm"
            />
          </div>
          <div className="flex items-end">
            <button
              onClick={handleCreate}
              disabled={actionLoading}
              className="w-full sm:w-auto rounded-full bg-brand-text px-8 py-2.5 text-sm font-semibold text-white shadow-lg hover:bg-brand-text/90 hover:shadow-xl hover:-translate-y-0.5 transition-all disabled:opacity-50"
            >
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
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-border border-t-brand-accent" />
          </div>
        ) : keys.length === 0 ? (
          <p className="px-7 py-12 text-center text-sm text-brand-muted">No API keys yet.</p>
        ) : (
          <div className="divide-y divide-brand-border">
            {keys.map((key) => (
              <div key={key.id} className="flex items-center justify-between px-7 py-4 gap-4 hover:bg-brand-surface transition-colors">
                <div className="flex items-center gap-4 min-w-0">
                  <span className="font-mono text-sm text-brand-text shrink-0">{key.keyPrefix}...</span>
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold shrink-0 ${key.revoked ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                    {key.revoked ? 'Revoked' : 'Active'}
                  </span>
                  {key.name && <span className="text-sm text-brand-muted truncate">{key.name}</span>}
                </div>
                <div className="flex items-center gap-6 shrink-0">
                  <span className="text-xs text-brand-muted hidden sm:block">
                    {key.lastUsedAt ? `Used ${new Date(key.lastUsedAt).toLocaleDateString()}` : 'Never used'}
                  </span>
                  <span className="text-xs text-brand-muted hidden md:block">
                    Created {new Date(key.createdAt).toLocaleDateString()}
                  </span>
                  {!key.revoked && (
                    <button
                      onClick={() => handleRevoke(key.id)}
                      disabled={actionLoading}
                      className="rounded-full border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-100 hover:border-red-300 transition-colors disabled:opacity-50"
                    >
                      Revoke
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-brand-border bg-white p-7 shadow-xl relative overflow-hidden ring-1 ring-black/5">
        <h2 className="text-xl font-bold font-serif text-brand-text">Quick Start</h2>
        <div className="mt-5">
          <pre className="rounded-xl bg-brand-text p-5 text-sm text-brand-bg font-mono overflow-x-auto shadow-sm">
{`curl -X POST ${window.location.origin}/api/v1/transactions/intent \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "chainId": 84532,
    "interactions": [{
      "contract": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "functionName": "transfer",
      "functionArgs": ["0xRECIPIENT", "1000000"]
    }]
  }'`}
          </pre>
        </div>
      </div>
    </div>
  );
}
