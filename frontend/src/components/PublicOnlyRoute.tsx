import type { ReactNode } from 'react';
import { useAppSession } from './AppSessionProvider';
import { Navigate, useLocation } from 'react-router-dom';

type RedirectState = {
  from?: {
    pathname?: string;
    search?: string;
    hash?: string;
  };
};

function getDashboardRedirectPath(state: unknown) {
  const from = (state as RedirectState | null)?.from;

  if (!from?.pathname?.startsWith('/dashboard')) {
    return '/dashboard';
  }

  return `${from.pathname}${from.search ?? ''}${from.hash ?? ''}`;
}


export default function PublicOnlyRoute({ children }: { children: ReactNode }) {
  const { session, loading, error, refresh } = useAppSession();
  const location = useLocation();

  if (!session && (loading || error)) {
    return (
      <div className="flex min-h-[320px] w-full items-center justify-center rounded-2xl border border-brand-border bg-white p-8 text-center shadow-2xl shadow-[#E8E2D9]/40">
        <div className="max-w-sm">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-accent/10">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-brand-accent border-t-transparent" />
          </div>
          <p className="mt-5 text-xs font-bold uppercase tracking-[0.24em] text-brand-muted">
            Account check
          </p>
          <h1 className="mt-2 font-serif text-2xl font-bold text-brand-text">
            {error ? 'Session check unavailable' : 'Checking your SOFA session'}
          </h1>
          <p className="mt-3 text-sm leading-6 text-brand-muted">
            Confirming whether to open the dashboard or continue email OTP sign-in.
          </p>
          <p className="mt-3 text-xs leading-5 text-brand-muted/80">
            {error ?? 'Your dashboard session is restored securely from the server.'}
          </p>
          <button
            type="button"
            onClick={() => { void refresh().catch(() => undefined); }}
            className="mt-4 rounded-full border border-brand-border px-4 py-2 text-xs font-bold uppercase tracking-[0.18em] text-brand-text transition hover:border-brand-accent hover:text-brand-accent"
          >
            Retry session check
          </button>
        </div>
      </div>
    );
  }

  if (session) {
    return <Navigate to={getDashboardRedirectPath(location.state)} replace />;
  }

  return <>{children}</>;
}
