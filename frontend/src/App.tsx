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
    <div className="flex min-h-screen items-center justify-center bg-brand-bg px-6 text-brand-text">
      <div className="w-full max-w-sm rounded-3xl border border-brand-border bg-white p-8 text-center shadow-xl">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-accent/10">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-brand-accent border-t-transparent" />
        </div>
        <p className="mt-5 text-xs font-bold uppercase tracking-[0.24em] text-brand-muted">
          SOFA ONE
        </p>
        <h1 className="mt-2 font-serif text-2xl font-bold text-brand-text">
          Loading your secure wallet workspace
        </h1>
        <p className="mt-3 text-sm leading-6 text-brand-muted">
          Preparing dashboard modules and Openfort wallet controls.
        </p>
      </div>
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
