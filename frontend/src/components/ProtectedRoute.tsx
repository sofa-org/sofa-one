import { useOpenfort } from '@openfort/react';
import { Navigate, useLocation } from 'react-router-dom';

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isLoading, user } = useOpenfort();
  const location = useLocation();
  const reloadPage = () => window.location.reload();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-brand-bg px-6 text-brand-text">
        <div className="w-full max-w-sm rounded-3xl border border-brand-border bg-white p-8 text-center shadow-xl">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-accent/10">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-brand-accent border-t-transparent" />
          </div>
          <p className="mt-5 text-xs font-bold uppercase tracking-[0.24em] text-brand-muted">
            Secure session
          </p>
          <h1 className="mt-2 font-serif text-2xl font-bold text-brand-text">
            Checking your Openfort session
          </h1>
          <p className="mt-3 text-sm leading-6 text-brand-muted">
            Verifying access before opening your wallet dashboard.
          </p>
          <button
            type="button"
            onClick={reloadPage}
            className="mt-5 rounded-full border border-brand-border px-4 py-2 text-xs font-bold uppercase tracking-[0.18em] text-brand-muted transition-colors hover:border-brand-accent hover:text-brand-accent"
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/sign-in" replace state={{ from: location }} />;
  }

  return <>{children}</>;
}
