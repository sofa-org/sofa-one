import type { ReactNode } from 'react';
import { useOpenfort } from '@openfort/react';
import { Navigate } from 'react-router-dom';

export default function PublicOnlyRoute({ children }: { children: ReactNode }) {
  const { user } = useOpenfort();

  if (user) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}
