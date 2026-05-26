import { AlertCircle, Eye, EyeOff, Loader2 } from 'lucide-react';

interface Step1CreateEoaProps {
  recoveryPassword: string;
  showRecoveryPassword: boolean;
  setRecoveryPassword: (value: string) => void;
  setShowRecoveryPassword: (value: boolean | ((prev: boolean) => boolean)) => void;
  walletSetupLoading: boolean;
  walletSetupError: string | null;
  onSubmit: (e: React.FormEvent) => void;
}

export function Step1CreateEoa({
  recoveryPassword,
  showRecoveryPassword,
  setRecoveryPassword,
  setShowRecoveryPassword,
  walletSetupLoading,
  walletSetupError,
  onSubmit,
}: Step1CreateEoaProps) {
  return (
    <form onSubmit={onSubmit} className="rounded-2xl border border-amber-200 bg-amber-50 p-5 shadow-sm">
      <div className="mb-4">
        <h2 className="font-serif text-xl font-bold text-brand-text">Step 1: Create your agent EOA</h2>
        <p className="mt-1 text-sm text-amber-800">Choose a recovery password. You will select networks in Step 2.</p>
      </div>

      {walletSetupError && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800 shadow-sm">
          <AlertCircle className="h-5 w-5 shrink-0 text-red-500" />
          {walletSetupError}
        </div>
      )}

      <div className="space-y-5">
        <div className="max-w-xl">
          <label className="mb-2 block text-[11px] font-bold uppercase tracking-widest text-brand-muted">
            Recovery Password
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
              placeholder="At least 8 characters"
              className="block w-full rounded-lg border border-amber-200 bg-white px-4 py-2.5 pr-11 text-sm text-brand-text shadow-sm placeholder:text-brand-muted focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent"
            />
            <button
              type="button"
              onClick={() => setShowRecoveryPassword((visible) => !visible)}
              className="absolute inset-y-0 right-2 flex items-center rounded-md px-2 text-amber-700 transition-colors hover:bg-amber-50 hover:text-amber-900"
              aria-label={showRecoveryPassword ? 'Hide recovery password' : 'Show recovery password'}
            >
              {showRecoveryPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <p className="mt-2 text-xs text-amber-800">
            This password unlocks the browser-local recovery flow when authorizing networks. Keep it available; SOFA ONE
            never stores or returns it.
          </p>
        </div>
      </div>

      <div className="mt-5 flex justify-end">
        <button
          type="submit"
          disabled={walletSetupLoading}
          className="flex items-center justify-center gap-2 rounded-full bg-brand-text px-8 py-2.5 text-sm font-semibold text-white shadow-lg transition-all hover:-translate-y-0.5 hover:bg-brand-text/90 hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-50"
        >
          {walletSetupLoading && <Loader2 className="h-4 w-4 animate-spin" />}
          <span>Create EOA</span>
        </button>
      </div>
    </form>
  );
}
