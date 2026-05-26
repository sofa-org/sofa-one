import { AlertCircle, CheckCircle2, Loader2, ExternalLink } from 'lucide-react';
import { CopyButton } from '@/components/CopyButton';
import { SUPPORTED_CHAINS } from '@/lib/chains';
import type { WithdrawSuccess } from './wallet-helpers';

interface WithdrawFormProps {
  to: string;
  amount: string;
  token: string;
  selectedChainId: number;
  withdrawLoading: boolean;
  withdrawResult: WithdrawSuccess | null;
  withdrawError: string | null;
  withdrawExplorerUrl: string | null;
  setTo: (value: string) => void;
  setAmount: (value: string) => void;
  setToken: (value: string) => void;
  setSelectedChainId: (chainId: number) => void;
  onSubmit: (e: React.FormEvent) => void;
  onReset: () => void;
}

export function WithdrawForm({
  to,
  amount,
  token,
  selectedChainId,
  withdrawLoading,
  withdrawResult,
  withdrawError,
  withdrawExplorerUrl,
  setTo,
  setAmount,
  setToken,
  setSelectedChainId,
  onSubmit,
  onReset,
}: WithdrawFormProps) {
  return (
    <div className="pt-6 border-t border-brand-border">
      <h3 className="text-base font-bold font-serif text-brand-text mb-6">Withdraw</h3>

      {withdrawError && (
        <div className="mb-6 flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800 shadow-sm">
          <AlertCircle className="h-5 w-5 shrink-0 text-red-500" />
          {withdrawError}
        </div>
      )}

      {withdrawResult && (
        <div className="mb-6 space-y-3 rounded-xl border border-green-200 bg-green-50 p-4 text-sm font-medium text-green-800 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-green-500" />
              <span>{withdrawResult.message}</span>
            </div>
            <button
              type="button"
              onClick={onReset}
              className="inline-flex items-center justify-center rounded-full border border-green-200 bg-white/70 px-4 py-1.5 text-xs font-bold uppercase tracking-widest text-green-800 transition hover:border-green-400 hover:bg-white hover:text-green-950"
            >
              Withdraw another
            </button>
          </div>
          {withdrawResult.transactionHash && (
            <div className="flex flex-col gap-3 rounded-lg border border-green-200/80 bg-white/70 p-3 text-xs text-green-900 sm:flex-row sm:items-center sm:justify-between">
              <span className="break-all font-mono">{withdrawResult.transactionHash}</span>
              <div className="flex shrink-0 items-center gap-2">
                <CopyButton text={withdrawResult.transactionHash} />
                {withdrawExplorerUrl && (
                  <a
                    href={withdrawExplorerUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-full border border-green-200 px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-green-800 transition hover:border-green-400 hover:text-green-950"
                  >
                    Explorer
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <form onSubmit={onSubmit} className="space-y-6">
        <div>
          <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted mb-2 block">
            Recipient Address
          </label>
          <input
            type="text"
            placeholder="0x..."
            value={to}
            onChange={(e) => setTo(e.target.value)}
            required
            pattern="^0x[a-fA-F0-9]{40}$"
            className="block w-full rounded-lg border border-brand-border px-4 py-2.5 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent placeholder:text-brand-muted bg-white shadow-sm"
          />
          <p className="mt-2 text-xs text-brand-muted">
            Send only to a 0x EVM address on the selected network. Double-check the chain before submitting.
          </p>
        </div>
        <div className="flex flex-col sm:flex-row items-stretch sm:items-end gap-4">
          <div className="w-full sm:w-48">
            <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted mb-2 block">Chain</label>
            <select
              value={selectedChainId}
              onChange={(e) => setSelectedChainId(Number(e.target.value))}
              className="block w-full rounded-lg border border-brand-border px-4 py-2.5 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent bg-white shadow-sm"
            >
              {SUPPORTED_CHAINS.map((chain) => (
                <option key={chain.id} value={chain.id}>
                  {chain.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted mb-2 block">
              Amount (USDC)
            </label>
            <input
              type="text"
              placeholder="1.00"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
              className="block w-full rounded-lg border border-brand-border px-4 py-2.5 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent placeholder:text-brand-muted bg-white shadow-sm"
            />
            <p className="mt-2 text-xs text-brand-muted">
              Enter a USDC amount. Keep enough native gas on this chain for the transaction.
            </p>
          </div>
          <div className="w-full sm:w-32">
            <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted mb-2 block">Token</label>
            <select
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="block w-full rounded-lg border border-brand-border px-4 py-2.5 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent bg-white shadow-sm"
            >
              <option value="USDC">USDC</option>
            </select>
          </div>
        </div>
        <div className="pt-2">
          <button
            type="submit"
            disabled={withdrawLoading}
            className="flex items-center justify-center gap-2 rounded-full bg-brand-text px-8 py-2.5 text-sm font-semibold text-white shadow-lg hover:bg-brand-text/90 hover:shadow-xl hover:-translate-y-0.5 transition-all disabled:opacity-50"
          >
            {withdrawLoading && <Loader2 className="h-4 w-4 animate-spin" />}
            <span>{withdrawLoading ? 'Submitting...' : 'Send Withdrawal'}</span>
          </button>
        </div>
      </form>
    </div>
  );
}
