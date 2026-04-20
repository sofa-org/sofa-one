import { SignUp } from '@clerk/nextjs';
import Link from 'next/link';

export default function SignUpPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-brand-bg px-4 py-12">
      <Link 
        href="/" 
        className="mb-10 font-serif text-3xl font-medium tracking-tight text-brand-text transition-opacity hover:opacity-80"
      >
        SOFA Agent Wallet
      </Link>
      <div className="w-full max-w-md">
        <SignUp forceRedirectUrl="/dashboard" />
      </div>
      <p className="mt-8 text-center text-xs text-brand-muted">
        By continuing, you acknowledge our Terms of Service and Privacy Policy.
      </p>
      <p className="mt-2 text-center text-xs text-brand-muted">
        Powered by{' '}
        <a
          href="https://sofa.org"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 decoration-brand-border hover:text-brand-text transition-colors"
        >
          SOFA.org
        </a>
      </p>
    </div>
  );
}
