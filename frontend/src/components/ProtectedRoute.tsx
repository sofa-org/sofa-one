import { useOpenfort } from '@openfort/react';
import { Navigate } from 'react-router-dom';

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user } = useOpenfort();

  if (!user) {
    return <Navigate to="/sign-in" replace />;
  }

  return <>{children}</>;
}
