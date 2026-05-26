import { Loader2, RotateCcw } from 'lucide-react';
import { TokenIcon } from './WalletIcons';
import { SUPPORTED_CHAINS } from '@/lib/chains';
import type { BalanceChain } from '@/lib/api';

interface BalanceDisplayProps {
  balances: BalanceChain[] | null;
  balancesLoading: boolean;
  balancesError: string | null;
  selectedChainId: number;
  setSelectedChainId: (chainId: number) => void;
  onRetryBalances: () => void;
}

export function BalanceDisplay({
  balances,
  balancesLoading,
  balancesError,
  selectedChainId,
  setSelectedChainId,
  onRetryBalances,
}: BalanceDisplayProps) {
  return (
    <div className="pt-6 border-t border-brand-border">
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">Assets</label>
        <div className="flex items-center gap-2">
          {balancesLoading && balances && (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Refreshing
            </span>
          )}
          <button
            onClick={onRetryBalances}
            disabled={balancesLoading}
            className="inline-flex items-center justify-center gap-1.5 rounded-full border border-brand-border bg-white px-3 py-1.5 text-xs font-semibold text-brand-text transition-all hover:border-brand-accent hover:bg-brand-bg disabled:opacity-50"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Retry
          </button>
          <select
            value={selectedChainId}
            onChange={(e) => setSelectedChainId(Number(e.target.value))}
            className="rounded-lg border border-brand-border bg-white px-3 py-1.5 text-sm font-medium text-brand-text shadow-sm focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent transition-colors cursor-pointer hover:bg-brand-bg/50"
          >
            {SUPPORTED_CHAINS.map((chain) => (
              <option key={chain.id} value={chain.id}>
                {chain.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {balancesError && (
          <div className="sm:col-span-2 flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800 shadow-sm sm:flex-row sm:items-center sm:justify-between">
            <span>{balancesError}</span>
            <button
              onClick={onRetryBalances}
              disabled={balancesLoading}
              className="inline-flex items-center justify-center gap-1.5 rounded-full border border-red-200 bg-white px-4 py-1.5 text-xs font-semibold text-red-700 transition-all hover:border-red-300 hover:bg-red-100 disabled:opacity-50"
            >
              {balancesLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
              Retry balances
            </button>
          </div>
        )}

        {balancesLoading && !balances ? (
          <>
            <div className="h-16 rounded-xl border border-brand-border/40 bg-brand-bg/30 animate-pulse" />
            <div className="h-16 rounded-xl border border-brand-border/40 bg-brand-bg/30 animate-pulse" />
          </>
        ) : balances && balances.length > 0 ? (
          balances.map((chain) =>
            chain.balances.map((b) => (
              <div
                key={`${chain.chainId}-${b.token}`}
                className="group relative flex items-center justify-between overflow-hidden rounded-xl border border-brand-border/60 bg-white p-3.5 transition-all hover:border-brand-accent/40 hover:shadow-[0_4px_12px_-4px_rgba(0,0,0,0.05)]"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-bg ring-1 ring-brand-border/60">
                    <TokenIcon token={b.token} />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-brand-text">{b.token}</p>
                    <p className="text-[10px] font-medium uppercase tracking-wider text-brand-muted">
                      {chain.chainName || `Chain ${chain.chainId}`}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="font-mono text-[13px] font-medium text-brand-text">
                    {b.error ? '—' : b.formatted}
                  </p>
                </div>
              </div>
            )),
          )
        ) : null}
      </div>
    </div>
  );
}
