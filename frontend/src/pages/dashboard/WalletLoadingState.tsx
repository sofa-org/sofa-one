import { Loader2 } from 'lucide-react';
import { DashboardCard } from './components/DashboardPage';

export function WalletLoadingState() {
  return (
    <DashboardCard>
      <div className="space-y-6 py-2">
        <div className="flex items-start gap-4">
          <div className="rounded-full bg-brand-accent/10 p-3">
            <Loader2 className="h-5 w-5 animate-spin text-brand-accent" />
          </div>
          <div>
            <h2 className="font-serif text-xl font-bold text-brand-text">Preparing your wallet dashboard</h2>
            <p className="mt-1 text-sm text-brand-muted">
              We are checking your Openfort session, wallet provisioning status, and API access authorization.
            </p>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {['Session', 'Agent wallet', 'Balances'].map((label) => (
            <div key={label} className="rounded-xl border border-brand-border/60 bg-brand-bg/40 p-4">
              <div className="mb-3 h-3 w-20 rounded-full bg-brand-border/70" />
              <div className="h-8 rounded-lg bg-brand-border/50" />
              <p className="mt-3 text-xs font-semibold uppercase tracking-widest text-brand-muted">{label}</p>
            </div>
          ))}
        </div>
      </div>
    </DashboardCard>
  );
}
