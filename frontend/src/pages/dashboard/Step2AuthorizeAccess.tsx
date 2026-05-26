import { AlertCircle, CheckCircle2, Loader2, ExternalLink, Eye, EyeOff } from 'lucide-react';
import { CopyButton } from '@/components/CopyButton';
import { SUPPORTED_CHAINS } from '@/lib/chains';
import {
  formatAgentStatus,
  formatDateTimeLocal,
  getMaxAgentExpiryLocal,
} from './wallet-helpers';

interface Step2AuthorizeAccessProps {
  walletAddress: string;
  agentChainId: number;
  setAgentChainId: (chainId: number) => void;
  agentChainName: string;
  agentNativeSymbol: string;
  isSelectedChainRegistered: boolean;
  selectedAuthorizationStatus: string | null;
  shouldPromptReauthorization: boolean;
  selectedAuthorizationExpiry: {
    absoluteLabel: string;
    relativeLabel: string;
    tone: string;
  } | null;
  selectedAuthorizationExpiryClasses: string;
  walletSetupError: string | null;
  walletSetupSuccess: string | null;
  walletExplorerUrl: string | null;
  agentGasHelpUrl: string | null;
  pendingAuthorizationTxHash: string | null;
  pendingAuthorizationExplorerUrl: string | null;
  agentRegistrationCheckStatus: 'idle' | 'checking' | 'timed_out';
  isAgentRegistrationChecking: boolean;
  registrationBusy: boolean;
  showAgentRegistrationSpinner: boolean;
  authorizeSubmitDisabled: boolean;
  recoveryPassword: string;
  showRecoveryPassword: boolean;
  setRecoveryPassword: (value: string) => void;
  setShowRecoveryPassword: (value: boolean | ((prev: boolean) => boolean)) => void;
  agentExpiryLocal: string;
  setAgentExpiryLocal: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onRetryCheck: () => void;
}

export function Step2AuthorizeAccess({
  walletAddress,
  agentChainId,
  setAgentChainId,
  agentChainName,
  agentNativeSymbol,
  isSelectedChainRegistered,
  selectedAuthorizationStatus,
  shouldPromptReauthorization,
  selectedAuthorizationExpiry,
  selectedAuthorizationExpiryClasses,
  walletSetupError,
  walletSetupSuccess,
  walletExplorerUrl,
  agentGasHelpUrl,
  pendingAuthorizationTxHash,
  pendingAuthorizationExplorerUrl,
  agentRegistrationCheckStatus,
  isAgentRegistrationChecking,
  registrationBusy,
  showAgentRegistrationSpinner,
  authorizeSubmitDisabled,
  recoveryPassword,
  showRecoveryPassword,
  setRecoveryPassword,
  setShowRecoveryPassword,
  agentExpiryLocal,
  setAgentExpiryLocal,
  onSubmit,
  onRetryCheck,
}: Step2AuthorizeAccessProps) {
  return (
    <form
      onSubmit={onSubmit}
      className={`rounded-2xl border p-5 shadow-sm ${
        isSelectedChainRegistered ? 'border-green-200 bg-green-50' : 'border-blue-200 bg-blue-50'
      }`}
    >
      <div className="mb-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="font-serif text-xl font-bold text-brand-text">Step 2: Authorize API access</h2>
          <span
            className={`inline-flex w-fit rounded-full bg-white px-3 py-1 text-xs font-semibold ring-1 ${
              isSelectedChainRegistered ? 'text-green-800 ring-green-200' : 'text-blue-800 ring-blue-200'
            }`}
          >
            Status: {formatAgentStatus(selectedAuthorizationStatus)}
          </span>
        </div>
        <p className="mt-2 text-sm text-blue-800">
          {isSelectedChainRegistered
            ? `${agentChainName} is already authorized for API access.`
            : isAgentRegistrationChecking
              ? 'Authorization is checking on-chain. We will update this page automatically; do not submit another authorization.'
              : 'This one-time on-chain approval lets your backend submit transactions through API keys.'}
        </p>
        {!isSelectedChainRegistered && !isAgentRegistrationChecking && (
          <div className="mt-3 rounded-xl border border-blue-200 bg-white/70 p-4 text-sm text-blue-900 shadow-inner">
            <strong className="block text-blue-950">Before you authorize</strong>
            <ul className="mt-2 space-y-1.5 text-blue-800">
              <li>• Keep your Step 1 recovery password ready to unlock the EOA in this browser.</li>
              <li>• Deposit a small amount of {agentNativeSymbol} on the selected network for gas.</li>
              <li>• Choose a future authorization expiry that matches this backend integration.</li>
            </ul>
          </div>
        )}
        {!isSelectedChainRegistered && (
          <div className="mt-3 rounded-xl bg-white/70 p-4 text-sm text-blue-900 border border-blue-200 shadow-inner">
            <strong className="block mb-1 text-blue-950">Deposit gas to continue</strong>
            <p className="mb-3 text-blue-800">
              Send a small amount of {agentNativeSymbol} on {agentChainName} to this EOA address. Then use your Step 1
              password to sign the one-time Calibur authorization in your browser.
            </p>
            <div className="flex items-center gap-2 bg-white rounded-md p-1.5 border border-blue-200 shadow-sm">
              <code className="min-w-0 flex-1 break-all px-2 py-1 font-mono text-xs text-brand-text">
                {walletAddress}
              </code>
              <CopyButton
                text={walletAddress}
                className="border-blue-300 text-blue-600 hover:bg-blue-100 bg-blue-50"
              />
            </div>
            {walletExplorerUrl && (
              <a
                href={walletExplorerUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700 hover:text-blue-900"
              >
                View EOA on {agentChainName} explorer
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
            {agentGasHelpUrl && (
              <a
                href={agentGasHelpUrl}
                target="_blank"
                rel="noreferrer"
                className="ml-0 mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700 hover:text-blue-900 sm:ml-4"
              >
                Get testnet {agentNativeSymbol}
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        )}
      </div>

      {walletSetupError && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800 shadow-sm">
          <AlertCircle className="h-5 w-5 shrink-0 text-red-500" />
          {walletSetupError}
        </div>
      )}

      {walletSetupSuccess && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-green-200 bg-green-50 p-4 text-sm font-medium text-green-800 shadow-sm">
          <CheckCircle2 className="h-5 w-5 shrink-0 text-green-500" />
          <span className="break-all">{walletSetupSuccess}</span>
        </div>
      )}

      {pendingAuthorizationTxHash && (
        <div className="mb-4 rounded-xl border border-blue-200 bg-white/80 p-4 text-sm text-blue-900 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-semibold">
                {agentRegistrationCheckStatus === 'checking'
                  ? 'Checking on-chain authorization...'
                  : 'Authorization submitted; confirmation is not complete yet.'}
              </p>
              <div className="mt-2 flex max-w-xl items-center gap-2 rounded-lg border border-blue-200 bg-blue-50/70 p-1.5">
                <code className="min-w-0 flex-1 break-all px-2 py-1 font-mono text-xs text-blue-900">
                  Tx: {pendingAuthorizationTxHash}
                </code>
                <CopyButton
                  text={pendingAuthorizationTxHash}
                  className="shrink-0 border-blue-300 bg-white text-blue-700 hover:bg-blue-100"
                />
              </div>
              {pendingAuthorizationExplorerUrl && (
                <a
                  href={pendingAuthorizationExplorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700 hover:text-blue-900"
                >
                  View authorization transaction on explorer
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
            <button
              type="button"
              onClick={onRetryCheck}
              disabled={showAgentRegistrationSpinner}
              className="inline-flex items-center justify-center gap-2 rounded-full border border-blue-300 bg-blue-50 px-4 py-2 text-xs font-semibold text-blue-800 transition-colors hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {agentRegistrationCheckStatus === 'checking' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Retry check
            </button>
          </div>
        </div>
      )}

      {isSelectedChainRegistered && selectedAuthorizationExpiry && (
        <div className={`mb-4 rounded-xl border p-4 text-sm shadow-sm ${selectedAuthorizationExpiryClasses}`}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-semibold">
                Current network authorization expires {selectedAuthorizationExpiry.relativeLabel.toLowerCase()}.
              </p>
              <p className="mt-1 text-xs opacity-80">
                Exact expiry: {selectedAuthorizationExpiry.absoluteLabel}. Re-authorize before then if this backend
                integration must keep running.
              </p>
            </div>
            {shouldPromptReauthorization && (
              <span className="inline-flex items-center justify-center rounded-full bg-white/80 px-3 py-1.5 text-xs font-semibold shadow-sm ring-1 ring-current/20">
                Re-authorize below
              </span>
            )}
          </div>
        </div>
      )}

      <div className="mb-4 grid gap-3 rounded-xl border border-blue-200 bg-white/70 p-4 text-sm text-blue-950 shadow-inner sm:grid-cols-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-blue-500">Selected network</p>
          <p className="mt-1 font-semibold">{agentChainName}</p>
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-blue-500">Current status</p>
          <p className="mt-1 font-semibold">{formatAgentStatus(selectedAuthorizationStatus)}</p>
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-blue-500">This submission will</p>
          <p className="mt-1 font-semibold">
            {isSelectedChainRegistered && shouldPromptReauthorization
              ? 'Renew API access'
              : isSelectedChainRegistered
                ? 'Keep access unchanged'
                : 'Authorize API access'}
          </p>
        </div>
        <p className="sm:col-span-3 text-xs leading-5 text-blue-700">
          Authorization is chain-specific. Changing the selected network changes which chain your backend can use with
          API keys.
        </p>
      </div>

      <div className="grid gap-4 rounded-xl border border-blue-100 bg-blue-100/30 p-4 md:grid-cols-[180px_180px_1fr_auto] md:items-end">
        <div>
          <label className="mb-2 block text-[11px] font-bold uppercase tracking-widest text-brand-muted">
            Network
          </label>
          <select
            value={agentChainId}
            onChange={(event) => setAgentChainId(Number(event.target.value))}
            disabled={registrationBusy}
            className="block w-full rounded-lg border border-blue-200 bg-white px-3 py-2.5 pr-8 text-sm font-medium text-brand-text shadow-sm focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            {SUPPORTED_CHAINS.map((chain) => (
              <option key={chain.id} value={chain.id}>
                {chain.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-2 block text-[11px] font-bold uppercase tracking-widest text-brand-muted">
            Authorization expiry
          </label>
          <input
            type="datetime-local"
            value={agentExpiryLocal}
            min={formatDateTimeLocal(new Date(Date.now() + 60_000))}
            max={getMaxAgentExpiryLocal()}
            onChange={(event) => setAgentExpiryLocal(event.target.value)}
            disabled={authorizeSubmitDisabled}
            required
            className="block w-full rounded-lg border border-blue-200 bg-white px-4 py-2.5 text-sm text-brand-text shadow-sm placeholder:text-brand-muted focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent disabled:cursor-not-allowed disabled:opacity-60"
          />
          <p className="mt-1 text-[11px] text-brand-muted">
            Maximum authorization lifetime is 30 days. Re-authorize before expiry for long-running integrations.
          </p>
        </div>
        <div className="flex-1">
          <label className="mb-2 block text-[11px] font-bold uppercase tracking-widest text-brand-muted">
            Step 1 Wallet Password
          </label>
          <div className="relative">
            <input
              type={showRecoveryPassword ? 'text' : 'password'}
              autoCapitalize="none"
              autoComplete="new-password"
              spellCheck={false}
              minLength={8}
              value={recoveryPassword}
              onChange={(event) => setRecoveryPassword(event.target.value)}
              placeholder="Enter the password you created in Step 1"
              disabled={authorizeSubmitDisabled}
              className="block w-full rounded-lg border border-blue-200 bg-white px-4 py-2.5 pr-11 text-sm text-brand-text shadow-sm placeholder:text-brand-muted focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent disabled:cursor-not-allowed disabled:opacity-60"
            />
            <button
              type="button"
              onClick={() => setShowRecoveryPassword((visible) => !visible)}
              disabled={authorizeSubmitDisabled}
              className="absolute inset-y-0 right-2 flex items-center rounded-md px-2 text-blue-700 transition-colors hover:bg-blue-50 hover:text-blue-900 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={showRecoveryPassword ? 'Hide recovery password' : 'Show recovery password'}
            >
              {showRecoveryPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={authorizeSubmitDisabled}
            className="flex h-[42px] items-center justify-center gap-2 whitespace-nowrap rounded-full bg-brand-text px-8 text-sm font-semibold text-white shadow-lg transition-all hover:-translate-y-0.5 hover:bg-brand-text/90 hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-50"
          >
            {showAgentRegistrationSpinner && <Loader2 className="h-4 w-4 animate-spin" />}
            <span>
              {isSelectedChainRegistered && shouldPromptReauthorization
                ? 'Re-authorize API Access'
                : isSelectedChainRegistered
                  ? 'Authorized'
                  : isAgentRegistrationChecking
                    ? 'Authorization pending'
                    : 'Authorize API Access'}
            </span>
          </button>
        </div>
      </div>
    </form>
  );
}
