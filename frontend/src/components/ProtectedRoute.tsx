import { useOpenfort } from '@openfort/react';
import { Navigate } from 'react-router-dom';

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isLoading, user } = useOpenfort();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-brand-bg text-sm text-brand-muted">
        Loading…
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/sign-in" replace />;
  }

  return <>{children}</>;
}
