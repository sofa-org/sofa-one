import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';
import ProtectedRoute from './components/ProtectedRoute';
import LandingPage from './pages/Landing';
import SignInPage from './pages/SignIn';
import SignUpPage from './pages/SignUp';
import DashboardLayout from './pages/dashboard/DashboardLayout';
import WalletPage from './pages/dashboard/Wallet';
import ApiKeysPage from './pages/dashboard/ApiKeys';
import TransactionsPage from './pages/dashboard/Transactions';
import APIDocsPage from './pages/dashboard/Docs';

function AuthRedirect({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return null;
  if (isSignedIn) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <div className="min-h-screen bg-brand-bg text-brand-text font-sans antialiased selection:bg-brand-accent selection:text-white">
      <Routes>
        <Route
          path="/"
          element={
            <AuthRedirect>
              <LandingPage />
            </AuthRedirect>
          }
        />
        <Route path="/sign-in/*" element={<SignInPage />} />
        <Route path="/sign-up/*" element={<SignUpPage />} />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <DashboardLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<WalletPage />} />
          <Route path="api-keys" element={<ApiKeysPage />} />
          <Route path="transactions" element={<TransactionsPage />} />
          <Route path="docs" element={<APIDocsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
