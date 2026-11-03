import { Link } from 'react-router-dom';
import { AlertCircle, ArrowRight, CheckCircle2, Loader2, ExternalLink, ShieldCheck, Trash2 } from 'lucide-react';
import { CopyButton } from '@/components/CopyButton';
import { SUPPORTED_CHAINS } from '@/lib/chains';
import type { ListWithdrawalAddressesResponse, WithdrawalToken } from '@/lib/api';
import type { WithdrawError, WithdrawSuccess } from './wallet-helpers';
import { isWithdrawalTerminal, type WithdrawalIntent } from './wallet-recovery';

export interface WithdrawFormProps {
  to: string;
  amount: string;
  token: WithdrawalToken;
  selectedChainId: number;
  withdrawalReady: boolean;
  withdrawalIntent: WithdrawalIntent | null;
  recoveryStorageError: string | null;
  onAuthorizeChain: () => void;
  onResumeWithdrawal: () => void;
  withdrawLoading: boolean;
  withdrawResult: WithdrawSuccess | null;
  withdrawError: WithdrawError | null;
  withdrawalAllowlist: ListWithdrawalAddressesResponse | null;
  withdrawalAllowlistLoading: boolean;
  withdrawalAllowlistError: string | null;
  newWithdrawalAddress: string;
  newWithdrawalAddressLabel: string;
  withdrawalAddressLoadingId: string | null;
  withdrawExplorerUrl: string | null;
  nativeCurrencySymbol: string;
  setTo: (value: string) => void;
  setAmount: (value: string) => void;
  setToken: (value: WithdrawalToken) => void;
  setSelectedChainId: (chainId: number) => void;
  setNewWithdrawalAddress: (value: string) => void;
  setNewWithdrawalAddressLabel: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onAddWithdrawalAddress: (e: React.FormEvent) => void;
  onRemoveWithdrawalAddress: (id: string) => void;
  onReset: () => void;
}

export function WithdrawForm({
  to,
  amount,
  token,
  selectedChainId,
  withdrawalReady,
  withdrawalIntent,
  recoveryStorageError,
  onAuthorizeChain,
  onResumeWithdrawal,
  withdrawLoading,
  withdrawResult,
  withdrawError,
  withdrawalAllowlist,
  withdrawalAllowlistLoading,
  withdrawalAllowlistError,
  newWithdrawalAddress,
  newWithdrawalAddressLabel,
  withdrawalAddressLoadingId,
  withdrawExplorerUrl,
  nativeCurrencySymbol,
  setTo,
  setAmount,
  setToken,
  setSelectedChainId,
  setNewWithdrawalAddress,
  setNewWithdrawalAddressLabel,
  onSubmit,
  onAddWithdrawalAddress,
  onRemoveWithdrawalAddress,
  onReset,
}: WithdrawFormProps) {
  const cooldownHours = withdrawalAllowlist?.policy.newAddressCooldownHours ?? 24;
  const amountLabel = token === 'NATIVE' ? `Amount (${nativeCurrencySymbol})` : `Amount (${token})`;
  const amountHelp = token === 'NATIVE'
    ? `Enter a ${nativeCurrencySymbol} amount in native token units. Leave enough ${nativeCurrencySymbol} for gas.`
    : `Enter a ${token} amount. Keep enough native gas on this chain for the transaction.`;
  const intentPending = Boolean(withdrawalIntent && !isWithdrawalTerminal(withdrawalIntent.status));

  return (
    <div className="pt-6 border-t border-brand-border">
      <h3 className="text-base font-bold font-serif text-brand-text mb-6">Withdraw</h3>

      {recoveryStorageError && <p role="alert" className="mb-4 text-sm text-red-800">{recoveryStorageError}</p>}
      {!withdrawalReady && (
        <div role="status" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          <p>Withdrawals require current API authorization on {SUPPORTED_CHAINS.find((chain) => chain.id === selectedChainId)?.name ?? `chain ${selectedChainId}`}. Balances remain available.</p>
          <button type="button" onClick={onAuthorizeChain} className="mt-2 font-semibold underline">Authorize / renew this chain</button>
        </div>
      )}
      {withdrawalIntent && (
        <div role="status" className="mb-4 space-y-2 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950">
          <p>{intentPending ? 'Withdrawal outcome is not confirmed. Resume this saved withdrawal; do not submit a duplicate.' : `Saved withdrawal status: ${withdrawalIntent.status}.`}</p>
          <p className="break-all">{withdrawalIntent.displayAmount} {withdrawalIntent.token} to {withdrawalIntent.to} on chain {withdrawalIntent.chainId}.</p>
          <p className="break-all font-mono text-xs">Intent: {withdrawalIntent.idempotencyKey}</p>
          {withdrawalIntent.transactionId && <p className="break-all font-mono text-xs">Transaction: {withdrawalIntent.transactionId}</p>}
          {intentPending ? <button type="button" disabled={withdrawLoading || Boolean(recoveryStorageError)} onClick={onResumeWithdrawal} className="font-semibold underline disabled:opacity-50">{withdrawLoading ? 'Checking withdrawal...' : 'Resume withdrawal'}</button>
            : !withdrawResult && <button type="button" onClick={onReset} className="font-semibold underline">Withdraw another</button>}
        </div>
      )}

      {withdrawError && (
        <div className="mb-6 flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
            <span>{withdrawError.message}</span>
          </div>
          {withdrawError.billingBlocked && (
            <Link
              to="/dashboard/billing"
              className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full border border-red-200 bg-white px-4 py-1.5 text-xs font-semibold text-red-700 transition-all hover:border-red-300 hover:bg-red-100"
            >
              Go to Billing
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          )}
        </div>
      )}

      {withdrawResult && (
        <div className={`mb-6 space-y-3 rounded-xl border p-4 text-sm font-medium shadow-sm ${withdrawResult.status === 'confirmed' ? 'border-green-200 bg-green-50 text-green-800' : 'border-red-200 bg-red-50 text-red-800'}`}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              {withdrawResult.status === 'confirmed' ? <CheckCircle2 className="h-5 w-5 shrink-0 text-green-500" /> : <AlertCircle className="h-5 w-5 shrink-0 text-red-500" />}
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

      <section className="mb-6 rounded-xl border border-brand-border bg-brand-bg/30 p-4">
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-bold text-brand-text">
              <ShieldCheck className="h-4 w-4 text-brand-accent" />
              Withdrawal address allowlist
            </div>
            <p className="mt-1 text-xs text-brand-muted">
              New addresses require step-up and become withdrawable after {cooldownHours}h. Adding an address enables the allowlist policy.
            </p>
          </div>
          {withdrawalAllowlistLoading && (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading
            </span>
          )}
        </div>

        {withdrawalAllowlistError && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs font-medium text-red-800">
            <AlertCircle className="h-4 w-4 shrink-0 text-red-500" />
            {withdrawalAllowlistError}
          </div>
        )}

        <form onSubmit={onAddWithdrawalAddress} className="mb-4 grid gap-3 lg:grid-cols-[1fr_180px_auto]">
          <input
            type="text"
            placeholder="0x allowlisted address"
            value={newWithdrawalAddress}
            onChange={(e) => setNewWithdrawalAddress(e.target.value)}
            required
            pattern="^0x[a-fA-F0-9]{40}$"
            className="block w-full rounded-lg border border-brand-border px-4 py-2.5 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent placeholder:text-brand-muted bg-white shadow-sm"
          />
          <input
            type="text"
            placeholder="Label optional"
            value={newWithdrawalAddressLabel}
            onChange={(e) => setNewWithdrawalAddressLabel(e.target.value)}
            maxLength={100}
            className="block w-full rounded-lg border border-brand-border px-4 py-2.5 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent placeholder:text-brand-muted bg-white shadow-sm"
          />
          <button
            type="submit"
            disabled={withdrawalAddressLoadingId === 'new'}
            className="inline-flex items-center justify-center gap-2 rounded-full border border-brand-border bg-white px-5 py-2.5 text-xs font-bold uppercase tracking-widest text-brand-text transition hover:border-brand-accent hover:text-brand-accent disabled:opacity-50"
          >
            {withdrawalAddressLoadingId === 'new' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Add
          </button>
        </form>

        <div className="space-y-2">
          {withdrawalAllowlist?.addresses.length ? (
            withdrawalAllowlist.addresses.map((entry) => (
              <div
                key={entry.id}
                className="flex flex-col gap-3 rounded-lg border border-brand-border bg-white p-3 text-xs sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {entry.label && <span className="font-semibold text-brand-text">{entry.label}</span>}
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${
                        entry.isAvailable ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'
                      }`}
                    >
                      {entry.isAvailable ? 'Ready' : `Locked until ${new Date(entry.availableAt).toLocaleString()}`}
                    </span>
                  </div>
                  <code className="mt-1 block break-all font-mono text-brand-muted">{entry.address}</code>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setTo(entry.address)}
                    disabled={!entry.isAvailable}
                    className="rounded-full border border-brand-border px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-brand-text transition hover:border-brand-accent hover:text-brand-accent disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Use
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemoveWithdrawalAddress(entry.id)}
                    disabled={withdrawalAddressLoadingId === entry.id}
                    className="rounded-full border border-red-200 p-1.5 text-red-600 transition hover:bg-red-50 disabled:opacity-50"
                    aria-label="Remove withdrawal address"
                  >
                    {withdrawalAddressLoadingId === entry.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              </div>
            ))
          ) : (
            <p className="rounded-lg border border-dashed border-brand-border p-3 text-xs text-brand-muted">
              No withdrawal addresses yet. Add one before withdrawing to enforce the allowlist and cooldown policy.
            </p>
          )}
        </div>
      </section>

      <form onSubmit={onSubmit} className="space-y-6">
        <fieldset disabled={withdrawLoading || Boolean(withdrawalIntent)}>
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
        <div className="flex flex-col items-stretch gap-4 sm:flex-row sm:items-start">
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
              {amountLabel}
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
              {amountHelp}
            </p>
          </div>
          <div className="w-full sm:w-32">
            <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted mb-2 block">Token</label>
            <select
              value={token}
              onChange={(e) => setToken(e.target.value as WithdrawalToken)}
              className="block w-full rounded-lg border border-brand-border px-4 py-2.5 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent bg-white shadow-sm"
            >
              <option value="USDC">USDC</option>
              <option value="USDT">USDT</option>
              <option value="NATIVE">{nativeCurrencySymbol}</option>
            </select>
          </div>
        </div>
        <div className="pt-2">
          <button
            type="submit"
            disabled={withdrawLoading || !withdrawalReady || Boolean(withdrawalIntent) || Boolean(recoveryStorageError)}
            className="flex items-center justify-center gap-2 rounded-full bg-brand-text px-8 py-2.5 text-sm font-semibold text-white shadow-lg hover:bg-brand-text/90 hover:shadow-xl hover:-translate-y-0.5 transition-all disabled:opacity-50"
          >
            {withdrawLoading && <Loader2 className="h-4 w-4 animate-spin" />}
            <span>{withdrawLoading ? 'Submitting...' : 'Send Withdrawal'}</span>
          </button>
        </div>
        </fieldset>
      </form>
    </div>
  );
}
