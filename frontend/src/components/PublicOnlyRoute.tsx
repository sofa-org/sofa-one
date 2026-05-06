import type { ReactNode } from 'react';
import { useOpenfort } from '@openfort/react';
import { Navigate } from 'react-router-dom';

export default function PublicOnlyRoute({ children }: { children: ReactNode }) {
  const { isLoading, user } = useOpenfort();

  if (isLoading) {
    return (
      <div className="flex min-h-[320px] w-full items-center justify-center rounded-2xl border border-brand-border bg-white p-8 text-sm text-brand-muted shadow-2xl shadow-[#E8E2D9]/40">
        Loading…
      </div>
    );
  }

  if (user) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}
