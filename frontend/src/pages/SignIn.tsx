import { lazy, Suspense } from 'react';
import { Link } from 'react-router-dom';

const AuthFormPanel = lazy(() => import('../components/AuthFormPanel'));

function AuthFormFallback() {
  return (
    <div className="w-full rounded-2xl border border-brand-border bg-white p-8 shadow-2xl shadow-[#E8E2D9]/40">
      <div className="h-7 w-28 animate-pulse rounded bg-brand-border/60" />
      <div className="mt-3 h-4 w-64 max-w-full animate-pulse rounded bg-brand-border/40" />
      <div className="mt-8 h-10 animate-pulse rounded-lg bg-brand-border/40" />
      <div className="mt-4 h-10 animate-pulse rounded-full bg-brand-text/20" />
    </div>
  );
}

export default function SignInPage() {
  return (
    <div className="flex min-h-screen bg-brand-bg">
      <div className="hidden lg:flex lg:w-1/2 relative flex-col items-center justify-center px-16 overflow-hidden">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-brand-accent/10 rounded-full blur-3xl" />
        <div className="absolute bottom-1/3 right-1/4 w-64 h-64 bg-brand-border/40 rounded-full blur-[100px]" />

        <div className="relative z-10 max-w-sm">
          <Link to="/" className="block mb-8">
            <span className="font-serif text-5xl font-medium tracking-tight text-brand-text">
              SOFA ONE<span className="text-brand-accent">.</span>
            </span>
          </Link>
          <p className="text-brand-muted text-lg leading-relaxed">
            Sign in with an email one-time code to provision your secure
            automated signing wallet.
          </p>
          <div className="mt-12 flex items-center gap-3">
            <div className="h-px w-8 bg-brand-accent" />
            <span className="text-xs text-brand-muted tracking-widest uppercase">Powered by SOFA.org</span>
          </div>
        </div>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center px-4 py-12 lg:bg-white/60">
        <Link
          to="/"
          className="mb-10 lg:hidden font-serif text-3xl font-medium tracking-tight text-brand-text transition-opacity hover:opacity-80"
        >
          SOFA ONE<span className="text-brand-accent">.</span>
        </Link>

        <div className="w-full max-w-sm">
          <Suspense fallback={<AuthFormFallback />}>
            <AuthFormPanel />
          </Suspense>
        </div>

        <p className="mt-8 text-center text-xs text-brand-muted">
          By continuing with email OTP, you agree to our{' '}
          <span className="underline underline-offset-2 decoration-brand-border cursor-pointer hover:text-brand-text transition-colors">Terms</span>
          {' '}and{' '}
          <span className="underline underline-offset-2 decoration-brand-border cursor-pointer hover:text-brand-text transition-colors">Privacy Policy</span>.
        </p>
      </div>
    </div>
  );
}
