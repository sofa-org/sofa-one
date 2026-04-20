import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { getTransactionHistoryAuth, withdrawAuth } from '@/lib/api';

interface Transaction {
  id: string;
  intentId: string | null;
  status: string;
  txHash: string | null;
  chainId: number | null;
  createdAt: string;
}

export default function TransactionsPage() {
  const { getToken } = useAuth();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Withdraw form
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [token, setToken] = useState('USDC');
  const [withdrawLoading, setWithdrawLoading] = useState(false);
  const [withdrawResult, setWithdrawResult] = useState<string | null>(null);

  async function fetchHistory() {
    try {
      const data = await getTransactionHistoryAuth(getToken);
      setTransactions(data.transactions);
      setTotal(data.total);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchHistory();
  }, []);

  async function handleWithdraw(e: React.FormEvent) {
    e.preventDefault();
    setWithdrawLoading(true);
    setWithdrawResult(null);
    setError(null);
    try {
      const result = await withdrawAuth(getToken, to, amount, token);
      setWithdrawResult(`Transaction submitted: ${result.intentId}`);
      setTo('');
      setAmount('');
      await fetchHistory();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setWithdrawLoading(false);
    }
  }

  const statusColor: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-700',
    confirmed: 'bg-green-100 text-green-700',
    failed: 'bg-red-100 text-red-700',
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold font-serif text-brand-text">Transactions</h1>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Withdraw form */}
      <div className="rounded-xl border border-brand-border bg-brand-surface p-6 shadow-sm">
        <h2 className="text-base font-semibold font-serif text-brand-text">Withdraw</h2>
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

      {/* Transaction history */}
      <div className="rounded-xl border border-brand-border bg-brand-surface shadow-sm">
        <div className="border-b border-brand-border px-6 py-4">
          <h2 className="text-base font-semibold font-serif text-brand-text">
            History <span className="text-sm font-normal text-brand-muted">({total} total)</span>
          </h2>
        </div>

        {loading ? (
          <div className="flex justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand-accent border-t-transparent" />
          </div>
        ) : transactions.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-brand-muted">No transactions yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-brand-border text-left text-xs font-medium text-brand-muted">
                  <th className="px-6 py-3">Intent ID</th>
                  <th className="px-6 py-3">Status</th>
                  <th className="px-6 py-3">Tx Hash</th>
                  <th className="px-6 py-3">Chain</th>
                  <th className="px-6 py-3">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-brand-border">
                {transactions.map((tx) => (
                  <tr key={tx.id} className="hover:bg-brand-bg">
                    <td className="px-6 py-3 font-mono text-xs text-brand-text">
                      {tx.intentId ? `${tx.intentId.slice(0, 16)}...` : '—'}
                    </td>
                    <td className="px-6 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          statusColor[tx.status] || 'bg-brand-bg text-brand-muted'
                        }`}
                      >
                        {tx.status}
                      </span>
                    </td>
                    <td className="px-6 py-3 font-mono text-xs text-brand-muted">
                      {tx.txHash ? `${tx.txHash.slice(0, 10)}...${tx.txHash.slice(-6)}` : '—'}
                    </td>
                    <td className="px-6 py-3 text-brand-text">{tx.chainId ?? '—'}</td>
                    <td className="px-6 py-3 text-brand-muted">
                      {new Date(tx.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
