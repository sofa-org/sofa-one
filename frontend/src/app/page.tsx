import Link from 'next/link';

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      {/* Nav */}
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <span className="text-xl font-bold tracking-tight">Agent Wallet</span>
          <div className="flex gap-3">
            <Link
              href="/sign-in"
              className="rounded-lg px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
            >
              Sign In
            </Link>
            <Link
              href="/sign-up"
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
            >
              Get Started
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <main className="flex flex-1 items-center justify-center px-6">
        <div className="max-w-2xl text-center">
          <h1 className="text-5xl font-bold tracking-tight text-gray-900">
            Automated Blockchain
            <br />
            <span className="text-indigo-600">Signing for Agents</span>
          </h1>
          <p className="mt-6 text-lg leading-8 text-gray-600">
            Sign in with your social account, get a wallet and API key instantly.
            Let your AI agents execute on-chain transactions — swap, transfer,
            mint — without ever touching a private key.
          </p>
          <div className="mt-10 flex items-center justify-center gap-4">
            <Link
              href="/sign-up"
              className="rounded-lg bg-indigo-600 px-6 py-3 text-base font-semibold text-white shadow-sm hover:bg-indigo-700"
            >
              Create Wallet
            </Link>
            <a
              href="https://www.openfort.io/blog/how-to-build-an-agent-wallet"
              target="_blank"
              rel="noopener noreferrer"
              className="text-base font-semibold text-gray-700 hover:text-gray-900"
            >
              Learn more &rarr;
            </a>
          </div>

          {/* Feature pills */}
          <div className="mt-16 flex flex-wrap items-center justify-center gap-3">
            {[
              'Social OAuth Login',
              'TEE-Secured Keys',
              'EIP-7702 Delegation',
              'USDC Gas Payments',
              'Batch Transactions',
              'API Key Auth',
            ].map((f) => (
              <span
                key={f}
                className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-sm text-gray-600"
              >
                {f}
              </span>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
