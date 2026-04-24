import { SignIn } from '@clerk/clerk-react';
import { Link } from 'react-router-dom';

export default function SignInPage() {
  return (
    <div className="flex min-h-screen bg-brand-bg">
      {/* Left brand panel - hidden on mobile */}
      <div className="hidden lg:flex lg:w-1/2 relative flex-col items-center justify-center px-16 overflow-hidden">
        {/* Decorative orbs */}
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-brand-accent/10 rounded-full blur-3xl" />
        <div className="absolute bottom-1/3 right-1/4 w-64 h-64 bg-brand-border/40 rounded-full blur-[100px]" />
        
        <div className="relative z-10 max-w-sm">
          <Link to="/" className="block mb-8">
            <span className="font-serif text-5xl font-medium tracking-tight text-brand-text">
              SOFA ONE<span className="text-brand-accent">.</span>
            </span>
          </Link>
          <p className="text-brand-muted text-lg leading-relaxed">
            Your secure, automated blockchain signing infrastructure.
          </p>
          <div className="mt-12 flex items-center gap-3">
            <div className="h-px w-8 bg-brand-accent" />
            <span className="text-xs text-brand-muted tracking-widest uppercase">Powered by SOFA.org</span>
          </div>
        </div>
      </div>

      {/* Right auth panel */}
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-12 lg:bg-white/60">
        {/* Mobile logo */}
        <Link
          to="/"
          className="mb-10 lg:hidden font-serif text-3xl font-medium tracking-tight text-brand-text transition-opacity hover:opacity-80"
        >
          SOFA ONE<span className="text-brand-accent">.</span>
        </Link>

        <div className="w-full max-w-sm flex justify-center">
          <SignIn routing="path" path="/sign-in" forceRedirectUrl="/dashboard" />
        </div>

        <p className="mt-8 text-center text-xs text-brand-muted">
          By continuing, you agree to our{' '}
          <span className="underline underline-offset-2 decoration-brand-border cursor-pointer hover:text-brand-text transition-colors">Terms</span>
          {' '}and{' '}
          <span className="underline underline-offset-2 decoration-brand-border cursor-pointer hover:text-brand-text transition-colors">Privacy Policy</span>.
        </p>
      </div>
    </div>
  );
}
