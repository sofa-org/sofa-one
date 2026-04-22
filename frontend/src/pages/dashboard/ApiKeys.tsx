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
  const { getToken } = useAuth();
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
    fetchKeys();
  }, []);

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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold font-serif text-brand-text">API Keys</h1>
        <button
          onClick={handleRefresh}
          disabled={actionLoading}
          className="rounded-full border border-brand-border px-4 py-2 text-sm font-medium text-brand-text hover:bg-brand-bg disabled:opacity-50"
        >
          Rotate All Keys
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {newRawKey && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-800">
            New API key created — save it now (shown only once):
          </p>
          <code className="mt-1 block break-all rounded bg-amber-100 px-3 py-2 font-mono text-sm text-amber-900">
            {newRawKey}
          </code>
          <button
            onClick={() => setNewRawKey(null)}
            className="mt-2 text-xs text-amber-700 underline"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="rounded-xl border border-brand-border bg-brand-surface p-6 shadow-sm">
        <h2 className="text-base font-semibold font-serif text-brand-text">Create New Key</h2>
        <div className="mt-3 flex gap-3">
          <input
            type="text"
            placeholder="Key name (optional)"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            className="flex-1 rounded-lg border border-brand-border px-3 py-2 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent placeholder-brand-muted"
          />
          <button
            onClick={handleCreate}
            disabled={actionLoading}
            className="rounded-full bg-brand-text px-4 py-2 text-sm font-medium text-white hover:bg-brand-text/90 disabled:opacity-50"
          >
            Create
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-brand-border bg-brand-surface shadow-sm">
        <div className="border-b border-brand-border px-6 py-4">
          <h2 className="text-base font-semibold font-serif text-brand-text">Your Keys</h2>
        </div>
        {loading ? (
          <div className="flex justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand-accent border-t-transparent" />
          </div>
        ) : keys.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-brand-muted">No API keys yet.</p>
        ) : (
          <div className="divide-y divide-brand-border">
            {keys.map((key) => (
              <div key={key.id} className="flex items-center justify-between px-6 py-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-brand-text">{key.keyPrefix}...</span>
                    {key.name && (
                      <span className="text-sm text-brand-muted">({key.name})</span>
                    )}
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        key.revoked
                          ? 'bg-red-100 text-red-700'
                          : 'bg-green-100 text-green-700'
                      }`}
                    >
                      {key.revoked ? 'Revoked' : 'Active'}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-brand-muted">
                    Created {new Date(key.createdAt).toLocaleDateString()}
                    {key.expiresAt &&
                      ` · Expires ${new Date(key.expiresAt).toLocaleDateString()}`}
                    {key.lastUsedAt
                      ? ` · Last used ${new Date(key.lastUsedAt).toLocaleString()}`
                      : ' · Never used'}
                  </p>
                </div>
                {!key.revoked && (
                  <button
                    onClick={() => handleRevoke(key.id)}
                    disabled={actionLoading}
                    className="rounded-full border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                  >
                    Revoke
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-brand-border bg-brand-surface p-6 shadow-sm">
        <h2 className="text-lg font-semibold font-serif text-brand-text">Quick Start</h2>
        <pre className="mt-4 overflow-x-auto rounded-lg bg-brand-text p-4 text-sm text-brand-bg">
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
  );
}
