import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { socialLogin, withdrawAuth, getBalancesAuth } from '@/lib/api';
import { BanknoteArrowUp, X, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';

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
    chainId: number;
    balances: Array<{
      token: string;
      raw: string | null;
      formatted: string | null;
      contractAddress?: string;
      error?: string;
    }>;
  }> | null>(null);
  const [balancesLoading, setBalancesLoading] = useState(false);

  const [showWithdraw, setShowWithdraw] = useState(false);
  
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

        setBalancesLoading(true);
        getBalancesAuth(getToken)
          .then((data) => {
            setBalances(data.chains);
          })
          .catch(() => {})
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
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-border border-t-brand-accent" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-6xl flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800 shadow-sm">
        <AlertCircle className="h-5 w-5 shrink-0 text-red-500" />
        {error}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-10 pb-16">
      <div className="border-b border-brand-border pb-6">
        <h1 className="text-3xl font-bold font-serif text-brand-text">Wallet Overview</h1>
        <p className="mt-2 text-sm text-brand-muted">Manage your TEE-secured wallet and balances</p>
      </div>

      {apiKeyDisplay && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 shadow-sm">
          <p className="text-sm font-medium text-amber-800 mb-2">
            Your API key (save it — shown only once):
          </p>
          <code className="block break-all rounded-lg bg-amber-100 px-4 py-3 font-mono text-sm text-amber-900 ring-1 ring-amber-200/50">
            {apiKeyDisplay}
          </code>
        </div>
      )}

      {wallet && (
        <div className="rounded-2xl border border-brand-border bg-white p-7 shadow-xl relative overflow-hidden ring-1 ring-black/5">
          <div className="absolute top-0 left-0 w-full h-1.5 bg-brand-text" />

          <div className="mt-0 space-y-6">
            <div>
              <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">Address</label>
              <div className="mt-1 flex items-center gap-3">
                <p className="break-all font-mono text-sm text-brand-text flex-1">
                  {wallet.walletAddress}
                </p>
                <button
                  type="button"
                  onClick={() => setShowWithdraw((v) => !v)}
                  className="shrink-0 rounded-full border border-brand-border p-1.5 text-brand-text hover:bg-brand-bg transition-colors"
                >
                  {showWithdraw ? <X className="h-4 w-4" /> : <BanknoteArrowUp className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div className="pt-6 border-t border-brand-border">
              <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted block mb-4">Assets</label>
              <div className="space-y-4">
                {balancesLoading ? (
                  <>
                    <div className="h-5 bg-brand-border/50 rounded animate-pulse w-1/3"></div>
                    <div className="h-5 bg-brand-border/50 rounded animate-pulse w-1/4"></div>
                  </>
                ) : balances ? (
                  balances.map((chain) => (
                    <div key={chain.chainId} className="space-y-3">
                      <p className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">Chain {chain.chainId}</p>
                      {chain.balances.map((b) => (
                        <div key={b.token} className="flex justify-between items-center text-sm font-mono text-brand-text bg-brand-bg/50 p-3 rounded-lg border border-brand-border/50">
                          <div className="flex items-center gap-2">
                            {b.token === 'USDC' && <span className="text-green-600 font-sans font-bold">$</span>}
                            {b.token === 'ETH' && <span className="text-blue-500 font-sans font-bold">Ξ</span>}
                            <span className="font-semibold">{b.token}</span>
                          </div>
                          <span>{b.error ? '—' : b.formatted}</span>
                        </div>
                      ))}
                    </div>
                  ))
                ) : null}
              </div>
            </div>

            {showWithdraw && (
              <div className="pt-6 border-t border-brand-border">
                <h3 className="text-base font-bold font-serif text-brand-text mb-6">Withdraw</h3>

                {withdrawError && (
                  <div className="mb-6 flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800 shadow-sm">
                    <AlertCircle className="h-5 w-5 shrink-0 text-red-500" />
                    {withdrawError}
                  </div>
                )}

                {withdrawResult && (
                  <div className="mb-6 flex items-center gap-3 rounded-xl border border-green-200 bg-green-50 p-4 text-sm font-medium text-green-800 shadow-sm">
                    <CheckCircle2 className="h-5 w-5 shrink-0 text-green-500" />
                    <span>{withdrawResult}</span>
                  </div>
                )}

                <form onSubmit={handleWithdraw} className="space-y-6">
                  <div>
                    <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted mb-2 block">Recipient Address</label>
                    <input
                      type="text"
                      placeholder="0x..."
                      value={to}
                      onChange={(e) => setTo(e.target.value)}
                      required
                      pattern="^0x[a-fA-F0-9]{40}$"
                      className="block w-full rounded-lg border border-brand-border px-4 py-2.5 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent placeholder:text-brand-muted bg-white shadow-sm"
                    />
                  </div>
                  <div className="flex flex-col sm:flex-row items-stretch sm:items-end gap-4">
                    <div className="flex-1">
                      <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted mb-2 block">Amount (base units)</label>
                      <input
                        type="text"
                        placeholder="1000000"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        required
                        className="block w-full rounded-lg border border-brand-border px-4 py-2.5 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent placeholder:text-brand-muted bg-white shadow-sm"
                      />
                    </div>
                    <div className="w-full sm:w-32">
                      <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted mb-2 block">Token</label>
                      <select
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                        className="block w-full rounded-lg border border-brand-border px-4 py-2.5 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent bg-white shadow-sm"
                      >
                        <option value="USDC">USDC</option>
                        <option value="ETH">ETH</option>
                      </select>
                    </div>
                  </div>
                  <div className="pt-2">
                    <button
                      type="submit"
                      disabled={withdrawLoading}
                      className="flex items-center justify-center gap-2 rounded-full bg-brand-text px-8 py-2.5 text-sm font-semibold text-white shadow-lg hover:bg-brand-text/90 hover:shadow-xl hover:-translate-y-0.5 transition-all disabled:opacity-50"
                    >
                      {withdrawLoading && (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      )}
                      <span>{withdrawLoading ? 'Submitting...' : 'Send Withdrawal'}</span>
                    </button>
                  </div>
                </form>
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
