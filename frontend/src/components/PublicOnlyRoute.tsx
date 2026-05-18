import type { ReactNode } from 'react';
import { useOpenfort } from '@openfort/react';
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
  const { isLoading, user } = useOpenfort();
  const location = useLocation();

  if (isLoading) {
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
            Checking your Openfort session
          </h1>
          <p className="mt-3 text-sm leading-6 text-brand-muted">
            Confirming whether to open the dashboard or continue email OTP sign-in.
          </p>
          <p className="mt-3 text-xs leading-5 text-brand-muted/80">
            If this check takes more than a few seconds, reload the page to refresh your Openfort session.
          </p>
        </div>
      </div>
    );
  }

  if (user) {
    return <Navigate to={getDashboardRedirectPath(location.state)} replace />;
  }

  return <>{children}</>;
}
