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
      <div className="flex min-h-[320px] w-full items-center justify-center rounded-2xl border border-brand-border bg-white p-8 text-sm text-brand-muted shadow-2xl shadow-[#E8E2D9]/40">
        Loading…
      </div>
    );
  }

  if (user) {
    return <Navigate to={getDashboardRedirectPath(location.state)} replace />;
  }

  return <>{children}</>;
}
