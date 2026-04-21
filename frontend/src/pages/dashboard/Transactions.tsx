import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { getTransactionHistoryAuth } from '@/lib/api';

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
