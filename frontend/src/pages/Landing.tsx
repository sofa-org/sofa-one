import { Link } from 'react-router-dom';

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 py-12 selection:bg-brand-accent selection:text-white">
      <div className="w-full max-w-3xl text-center">
        <div className="mb-16">
          <span className="font-serif text-3xl font-medium tracking-tight text-brand-text">
            SOFA ONE
          </span>
        </div>

        <h1 className="mb-6 font-serif text-5xl font-normal leading-tight tracking-tight text-brand-text md:text-6xl">
          Automated Blockchain Signing <br className="hidden md:block" />
          <span className="italic text-brand-accent">for AI Agents</span>
        </h1>

        <p className="mx-auto mb-12 max-w-2xl text-lg font-light leading-relaxed text-brand-muted md:text-xl">
          Sign in with email OTP, get a wallet and API key instantly. Let your AI
          agents execute on-chain transactions — swap, transfer, mint — without
          ever touching a private key.
        </p>

        <div className="mb-16 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            to="/sign-in"
            className="rounded-full bg-brand-text px-10 py-3.5 text-sm font-medium tracking-widest text-white transition-colors hover:bg-black/90"
          >
            SIGN IN WITH EMAIL OTP
          </Link>
          <Link
            to="/dashboard/docs"
            className="rounded-full border border-brand-border bg-white/70 px-8 py-3.5 text-sm font-medium tracking-widest text-brand-text transition-colors hover:border-brand-text hover:bg-white"
          >
            VIEW API DOCS
          </Link>
        </div>

        <div className="mb-16 flex flex-wrap items-center justify-center gap-3">
          {[
            'Email OTP Login',
            'TEE-Secured Keys',
            'EIP-7702 Delegation',
            'USDC Gas Payments',
            'Batch Transactions',
            'API Key Auth',
          ].map((feature) => (
            <span
              key={feature}
              className="rounded-full border border-brand-border bg-brand-surface/60 px-4 py-1.5 text-xs font-medium tracking-wide text-brand-muted backdrop-blur-sm"
            >
              {feature}
            </span>
          ))}
        </div>

        <div className="mt-8 flex flex-col items-center gap-3">
          <Link
            to="/dashboard"
            className="text-sm font-medium text-brand-muted transition-colors hover:text-brand-text underline underline-offset-4 decoration-brand-border hover:decoration-brand-text"
          >
            Open your wallet dashboard after sign-in
          </Link>
          <span className="text-xs text-brand-muted">
            Powered by{' '}
            <a
              href="https://sofa.org"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 decoration-brand-border hover:text-brand-text transition-colors"
            >
              SOFA.org
            </a>
          </span>
        </div>
      </div>
    </div>
  );
}
