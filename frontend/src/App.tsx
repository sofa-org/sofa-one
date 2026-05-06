import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';

const AuthProviders = lazy(() => import('./components/AuthProviders'));
const ProtectedRoute = lazy(() => import('./components/ProtectedRoute'));
const LandingPage = lazy(() => import('./pages/Landing'));
const SignInPage = lazy(() => import('./pages/SignIn'));
const DashboardLayout = lazy(() => import('./pages/dashboard/DashboardLayout'));
const WalletPage = lazy(() => import('./pages/dashboard/Wallet'));
const ApiKeysPage = lazy(() => import('./pages/dashboard/ApiKeys'));
const APIDocsPage = lazy(() => import('./pages/dashboard/Docs'));

function PageFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-bg text-sm text-brand-muted">
      Loading…
    </div>
  );
}

export default function App() {
  return (
    <div className="min-h-screen bg-brand-bg text-brand-text font-sans antialiased selection:bg-brand-accent selection:text-white">
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route
            path="/"
            element={<LandingPage />}
          />
          <Route
            path="/sign-in/*"
            element={<SignInPage />}
          />
          <Route
            path="/sign-up/*"
            element={<Navigate to="/sign-in" replace />}
          />
          <Route
            path="/dashboard"
            element={
              <AuthProviders>
                <ProtectedRoute>
                  <DashboardLayout />
                </ProtectedRoute>
              </AuthProviders>
            }
          >
            <Route index element={<WalletPage />} />
            <Route path="api-keys" element={<ApiKeysPage />} />
            <Route path="docs" element={<APIDocsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </div>
  );
}
