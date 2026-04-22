import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { socialLogin, withdrawAuth, getBalancesAuth } from '@/lib/api';

export default function WalletPage() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const [wallet, setWallet] = useState<{
    walletAddress: string;
    status: string;
  } | null>(null);
  const [apiKeyDisplay, setApiKeyDisplay] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const [balances, setBalances] = useState<Array<{
    token: string;
    raw: string | null;
    formatted: string | null;
    contractAddress?: string;
    error?: string;
  }> | null>(null);
  const [balancesLoading, setBalancesLoading] = useState(false);
  
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [token, setToken] = useState('USDC');
  const [withdrawLoading, setWithdrawLoading] = useState(false);
  const [withdrawResult, setWithdrawResult] = useState<string | null>(null);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;

    async function init() {
      try {
        const result = await socialLogin(getToken);
        if (result.apiKey) {
          setApiKeyDisplay(result.apiKey);
        }
        setWallet(result.wallet);

        // 加载余额（非阻塞）
        setBalancesLoading(true);
        getBalancesAuth(getToken)
          .then((data) => {
            setBalances(data.balances);
          })
          .catch(() => {
            // 静默失败
          })
          .finally(() => setBalancesLoading(false));
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    init();
  }, [isLoaded, isSignedIn, getToken]);

  async function handleWithdraw(e: React.FormEvent) {
    e.preventDefault();
    setWithdrawLoading(true);
    setWithdrawResult(null);
    setWithdrawError(null);
    try {
      const result = await withdrawAuth(getToken, to, amount, token);
      setWithdrawResult(`Transaction submitted: ${result.intentId}`);
      setTo('');
      setAmount('');
    } catch (err: any) {
      setWithdrawError(err.message);
    } finally {
      setWithdrawLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-accent border-t-transparent" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">{error}</div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold font-serif text-brand-text">Wallet Overview</h1>

      {apiKeyDisplay && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-800">
            Your API key (save it — shown only once):
          </p>
          <code className="mt-1 block break-all rounded bg-amber-100 px-3 py-2 font-mono text-sm text-amber-900">
            {apiKeyDisplay}
          </code>
        </div>
      )}

      {wallet && (
        <div className="rounded-xl border border-brand-border bg-brand-surface p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold font-serif text-brand-text">Deposit Address</h2>
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                wallet.status === 'active'
                  ? 'bg-green-100 text-green-700'
                  : 'bg-brand-bg text-brand-muted'
              }`}
            >
              {wallet.status}
            </span>
          </div>

          <div className="mt-4 space-y-3">
            <div>
              <label className="text-xs font-medium text-brand-muted">Address</label>
              <p className="mt-0.5 break-all font-mono text-sm text-brand-text">
                {wallet.walletAddress}
              </p>
            </div>
            
            <div className="pt-4 border-t border-brand-border">
              <label className="text-xs font-medium text-brand-muted block mb-2">Assets</label>
              <div className="space-y-2">
                {balancesLoading ? (
                  <>
                    <div className="h-5 bg-brand-border/50 rounded animate-pulse w-1/3"></div>
                    <div className="h-5 bg-brand-border/50 rounded animate-pulse w-1/4"></div>
                  </>
                ) : balances ? (
                  balances.map((b) => (
                    <div key={b.token} className="flex justify-between items-center text-sm font-mono text-brand-text">
                      <div className="flex items-center gap-1.5">
                        {b.token === 'USDC' && <span className="text-green-600 font-sans">$</span>}
                        {b.token === 'ETH' && <span className="text-blue-500 font-sans">Ξ</span>}
                        <span>{b.token}</span>
                      </div>
                      <span>{b.error ? '—' : b.formatted}</span>
                    </div>
                  ))
                ) : null}
              </div>
            </div>
          </div>

        </div>
      )}

      {/* Withdraw */}
      <div className="rounded-xl border border-brand-border bg-brand-surface p-6 shadow-sm">
        <h2 className="text-base font-semibold font-serif text-brand-text">Withdraw</h2>
        {withdrawError && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {withdrawError}
          </div>
        )}
        <form onSubmit={handleWithdraw} className="mt-4 space-y-3">
          <div>
            <label className="text-xs font-medium text-brand-muted">Recipient Address</label>
            <input
              type="text"
              placeholder="0x..."
              value={to}
              onChange={(e) => setTo(e.target.value)}
              required
              pattern="^0x[a-fA-F0-9]{40}$"
              className="mt-1 block w-full rounded-lg border border-brand-border px-3 py-2 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent placeholder-brand-muted"
            />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs font-medium text-brand-muted">Amount (base units)</label>
              <input
                type="text"
                placeholder="1000000 (= 1 USDC)"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
                className="mt-1 block w-full rounded-lg border border-brand-border px-3 py-2 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent placeholder-brand-muted"
              />
            </div>
            <div className="w-32">
              <label className="text-xs font-medium text-brand-muted">Token</label>
              <select
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className="mt-1 block w-full rounded-lg border border-brand-border px-3 py-2 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent"
              >
                <option value="USDC">USDC</option>
                <option value="ETH">ETH</option>
              </select>
            </div>
          </div>
          <button
            type="submit"
            disabled={withdrawLoading}
            className="rounded-full bg-brand-text px-4 py-2 text-sm font-medium text-white hover:bg-brand-text/90 disabled:opacity-50"
          >
            {withdrawLoading ? 'Submitting...' : 'Send Withdrawal'}
          </button>
        </form>
        {withdrawResult && (
          <p className="mt-3 text-sm text-green-600">{withdrawResult}</p>
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
