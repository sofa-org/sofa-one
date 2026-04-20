'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { socialLogin, setApiKey } from '@/lib/api';

export default function DashboardPage() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const [wallet, setWallet] = useState<{
    walletAddress: string;
    chainId: number;
    status: string;
    supportedTokens: string[];
  } | null>(null);
  const [apiKeyDisplay, setApiKeyDisplay] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Wait until Clerk has loaded and confirmed the user is signed in,
    // otherwise getToken() returns null and the backend rejects with 401.
    if (!isLoaded || !isSignedIn) return;

    async function init() {
      try {
        // Register / login with backend — response includes wallet info directly
        const result = await socialLogin(getToken);
        if (result.apiKey) {
          setApiKey(result.apiKey);
          setApiKeyDisplay(result.apiKey);
        }

        // Use wallet info returned by socialLogin — no separate API call needed
        setWallet(result.wallet);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    init();
  }, [isLoaded, isSignedIn, getToken]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">{error}</div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Wallet Overview</h1>

      {/* New API key alert */}
      {apiKeyDisplay && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-800">
            Your API key (save it — shown only once):
          </p>
          <code className="mt-1 block break-all rounded bg-amber-100 px-3 py-2 font-mono text-sm text-amber-900">
            {apiKeyDisplay}
          </code>
        </div>
      )}

      {/* Wallet card */}
      {wallet && (
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">Deposit Address</h2>
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                wallet.status === 'active'
                  ? 'bg-green-100 text-green-700'
                  : 'bg-gray-100 text-gray-600'
              }`}
            >
              {wallet.status}
            </span>
          </div>

          <div className="mt-4 space-y-3">
            <div>
              <label className="text-xs font-medium text-gray-500">Address</label>
              <p className="mt-0.5 break-all font-mono text-sm text-gray-900">
                {wallet.walletAddress}
              </p>
            </div>
            <div className="flex gap-6">
              <div>
                <label className="text-xs font-medium text-gray-500">Chain ID</label>
                <p className="mt-0.5 text-sm text-gray-900">{wallet.chainId}</p>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-500">Supported Tokens</label>
                <p className="mt-0.5 text-sm text-gray-900">
                  {wallet.supportedTokens.join(', ')}
                </p>
              </div>
            </div>
          </div>

          <div className="mt-5 rounded-lg bg-gray-50 p-4 text-sm text-gray-600">
            Send USDC or ETH to the address above to fund your agent wallet. Use the{' '}
            <a
              href="https://faucet.circle.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-600 underline"
            >
              Circle Faucet
            </a>{' '}
            for Base Sepolia test USDC.
          </div>
        </div>
      )}

      {/* Quick start */}
      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900">Quick Start</h2>
        <pre className="mt-4 overflow-x-auto rounded-lg bg-gray-900 p-4 text-sm text-gray-100">
{`curl -X POST ${typeof window !== 'undefined' ? window.location.origin : ''}/api/v1/transactions/intent \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "chainId": 84532,
    "interactions": [{
      "contract": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "functionName": "transfer",
      "functionArgs": ["0xRECIPIENT", "1000000"]
    }]
  }'`}
        </pre>
      </div>
    </div>
  );
}
