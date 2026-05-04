import type { ReactNode } from 'react';
import { useOpenfort } from '@openfort/react';
import { Navigate } from 'react-router-dom';

export default function PublicOnlyRoute({ children }: { children: ReactNode }) {
  const { isLoading, user } = useOpenfort();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-brand-bg text-sm text-brand-muted">
        Loading…
      </div>
    );
  }

  if (user) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}
