export default function APIDocsPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-12 pb-24 pt-8">
      {/* Header */}
      <div className="space-y-4">
        <h1 className="text-3xl font-bold font-serif text-brand-text">
          API Documentation
        </h1>
        <p className="text-base text-brand-muted max-w-2xl">
          Welcome to the Agent Wallet API. This reference provides all the endpoints needed to programmatically sign data and submit transactions via your TEE-secured backend wallet.
        </p>
      </div>

      {/* Authentication */}
      <section className="rounded-xl border border-brand-border bg-brand-surface p-6 shadow-sm">
        <h2 className="text-lg font-semibold font-serif text-brand-text mb-4">Authentication</h2>
        <p className="text-sm text-brand-muted mb-4">
          All API requests must be authenticated using your API Key. Include it in the headers of your requests as <code className="font-mono text-brand-accent bg-brand-accent/10 px-1.5 py-0.5 rounded">X-API-Key</code>.
        </p>
        <pre className="rounded-lg bg-brand-text p-4 text-sm text-brand-bg font-mono overflow-x-auto">
          <code>X-API-Key: sk_live_...</code>
        </pre>
      </section>

      {/* Endpoints */}
      <div className="space-y-8">
        <h2 className="text-2xl font-bold font-serif text-brand-text border-b border-brand-border pb-4">Endpoints</h2>

        {/* Endpoint 1 */}
        <section className="rounded-xl border border-brand-border bg-brand-surface p-6 shadow-sm space-y-6">
          <div className="flex items-center gap-3">
            <span className="rounded-full px-2.5 py-0.5 text-xs font-bold tracking-wide bg-amber-100 text-amber-800 border border-amber-200">
              POST
            </span>
            <h3 className="text-lg font-mono font-semibold text-brand-text">/v1/wallets/sign</h3>
          </div>
          <p className="text-sm text-brand-muted">
            Sign data with your wallet (no transaction broadcast). Supports EIP-191 messages, EIP-712 typed data, and raw hashes.
          </p>
          
          <div className="space-y-3">
            <h4 className="text-xs font-medium text-brand-muted uppercase tracking-wider">Request Body</h4>
            <div className="overflow-hidden border border-brand-border rounded-lg">
              <table className="w-full text-left text-sm">
                <thead className="bg-brand-bg text-brand-muted text-xs uppercase">
                  <tr>
                    <th className="px-4 py-3 font-medium">Parameter</th>
                    <th className="px-4 py-3 font-medium">Type</th>
                    <th className="px-4 py-3 font-medium">Required</th>
                    <th className="px-4 py-3 font-medium">Description</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-brand-border text-brand-text bg-brand-surface">
                  <tr>
                    <td className="px-4 py-3 font-mono text-xs">type</td>
                    <td className="px-4 py-3">string</td>
                    <td className="px-4 py-3 text-brand-accent">Yes</td>
                    <td className="px-4 py-3"><code className="text-xs">"message"</code> | <code className="text-xs">"typed_data"</code> | <code className="text-xs">"hash"</code></td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-mono text-xs">message</td>
                    <td className="px-4 py-3">string</td>
                    <td className="px-4 py-3 text-brand-muted">Cond.</td>
                    <td className="px-4 py-3">Plain text to sign (if type=message)</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-mono text-xs">typedData</td>
                    <td className="px-4 py-3">object</td>
                    <td className="px-4 py-3 text-brand-muted">Cond.</td>
                    <td className="px-4 py-3">EIP-712 struct with domain, types, primaryType, message</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-mono text-xs">hash</td>
                    <td className="px-4 py-3">string</td>
                    <td className="px-4 py-3 text-brand-muted">Cond.</td>
                    <td className="px-4 py-3">0x-prefixed 32-byte hash (if type=hash)</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-brand-muted uppercase tracking-wider">cURL Example</h4>
              <pre className="rounded-lg bg-brand-text p-4 text-sm text-brand-bg font-mono overflow-x-auto">
                <code>{`curl -X POST https://api.agentwallet.com/v1/wallets/sign \\
  -H "X-API-Key: sk_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{"type":"message", "message":"Hello, Agent Wallet!"}'`}</code>
              </pre>
            </div>
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-brand-muted uppercase tracking-wider">Response Example</h4>
              <pre className="rounded-lg bg-brand-text p-4 text-sm text-brand-bg font-mono overflow-x-auto">
                <code>{`{
  "signature": "0x5d99b6f7f6d1f73d1a...",
  "walletAddress": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
  "type": "message"
}`}</code>
              </pre>
            </div>
          </div>
        </section>

        {/* Endpoint 2 */}
        <section className="rounded-xl border border-brand-border bg-brand-surface p-6 shadow-sm space-y-6">
          <div className="flex items-center gap-3">
            <span className="rounded-full px-2.5 py-0.5 text-xs font-bold tracking-wide bg-amber-100 text-amber-800 border border-amber-200">
              POST
            </span>
            <h3 className="text-lg font-mono font-semibold text-brand-text">/v1/transactions/intent</h3>
          </div>
          <p className="text-sm text-brand-muted">
            Submit a transaction intent with contract interactions. Server handles signing, UserOperation bundling, and gas.
          </p>
          
          <div className="space-y-3">
            <h4 className="text-xs font-medium text-brand-muted uppercase tracking-wider">Request Body</h4>
            <div className="overflow-hidden border border-brand-border rounded-lg">
              <table className="w-full text-left text-sm">
                <thead className="bg-brand-bg text-brand-muted text-xs uppercase">
                  <tr>
                    <th className="px-4 py-3 font-medium">Parameter</th>
                    <th className="px-4 py-3 font-medium">Type</th>
                    <th className="px-4 py-3 font-medium">Required</th>
                    <th className="px-4 py-3 font-medium">Description</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-brand-border text-brand-text bg-brand-surface">
                  <tr>
                    <td className="px-4 py-3 font-mono text-xs">chainId</td>
                    <td className="px-4 py-3">number</td>
                    <td className="px-4 py-3 text-brand-accent">Yes</td>
                    <td className="px-4 py-3">Network ID (84532, 8453, 1)</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-mono text-xs">policyId</td>
                    <td className="px-4 py-3">string</td>
                    <td className="px-4 py-3 text-brand-muted">No</td>
                    <td className="px-4 py-3">Gas policy ID for USDC gas payment</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-mono text-xs">interactions</td>
                    <td className="px-4 py-3">array</td>
                    <td className="px-4 py-3 text-brand-accent">Yes</td>
                    <td className="px-4 py-3">Array of interaction objects</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-mono text-xs">└ contract</td>
                    <td className="px-4 py-3">string</td>
                    <td className="px-4 py-3 text-brand-accent">Yes</td>
                    <td className="px-4 py-3">0x-prefixed contract address</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-mono text-xs">└ functionName</td>
                    <td className="px-4 py-3">string</td>
                    <td className="px-4 py-3 text-brand-accent">Yes</td>
                    <td className="px-4 py-3">Contract function name (e.g., "transfer")</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-mono text-xs">└ functionArgs</td>
                    <td className="px-4 py-3">string[]</td>
                    <td className="px-4 py-3 text-brand-muted">No</td>
                    <td className="px-4 py-3">Array of function arguments</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-brand-muted uppercase tracking-wider">cURL Example</h4>
              <pre className="rounded-lg bg-brand-text p-4 text-sm text-brand-bg font-mono overflow-x-auto">
                <code>{`curl -X POST https://api.agentwallet.com/v1/transactions/intent \\
  -H "X-API-Key: sk_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "chainId": 84532,
    "interactions": [{
      "contract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "functionName": "transfer",
      "functionArgs": ["0xRecipient...", "1000000"]
    }]
  }'`}</code>
              </pre>
            </div>
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-brand-muted uppercase tracking-wider">Response Example</h4>
              <pre className="rounded-lg bg-brand-text p-4 text-sm text-brand-bg font-mono overflow-x-auto">
                <code>{`{
  "transactionId": "550e8400-e29b-41d4-a716-446655440000",
  "intentId": "tin_abc123def456",
  "status": "pending"
}`}</code>
              </pre>
            </div>
          </div>
        </section>

        {/* Endpoint 3 */}
        <section className="rounded-xl border border-brand-border bg-brand-surface p-6 shadow-sm space-y-6">
          <div className="flex items-center gap-3">
            <span className="rounded-full px-2.5 py-0.5 text-xs font-bold tracking-wide bg-amber-100 text-amber-800 border border-amber-200">
              POST
            </span>
            <h3 className="text-lg font-mono font-semibold text-brand-text">/v1/transactions/batch</h3>
          </div>
          <p className="text-sm text-brand-muted">
            Batch multiple interactions into one on-chain transaction via EIP-7702. The request and response format are identical to the intent endpoint.
          </p>
          
          <div className="flex flex-col gap-4">
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-brand-muted uppercase tracking-wider">cURL Example</h4>
              <pre className="rounded-lg bg-brand-text p-4 text-sm text-brand-bg font-mono overflow-x-auto">
                <code>{`curl -X POST https://api.agentwallet.com/v1/transactions/batch \\
  -H "X-API-Key: sk_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "chainId": 84532,
    "interactions": [
      {
        "contract": "0xTokenA...",
        "functionName": "approve",
        "functionArgs": ["0xSpender...", "1000000"]
      },
      {
        "contract": "0xRouter...",
        "functionName": "swapExactTokensForTokens",
        "functionArgs": ["1000000", "990000", "...", "0xRecipient...", "1712345678"]
      }
    ]
  }'`}</code>
              </pre>
            </div>
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-brand-muted uppercase tracking-wider">Response Example</h4>
              <pre className="rounded-lg bg-brand-text p-4 text-sm text-brand-bg font-mono overflow-x-auto">
                <code>{`{
  "transactionId": "9d7e52a1-b8f4-4a29-8f9c-1234567890ab",
  "intentId": "tin_batch789xyz",
  "status": "pending"
}`}</code>
              </pre>
            </div>
          </div>
        </section>

        {/* Endpoint 4 */}
        <section className="rounded-xl border border-brand-border bg-brand-surface p-6 shadow-sm space-y-6">
          <div className="flex items-center gap-3">
            <span className="rounded-full px-2.5 py-0.5 text-xs font-bold tracking-wide bg-emerald-100 text-emerald-800 border border-emerald-200">
              GET
            </span>
            <h3 className="text-lg font-mono font-semibold text-brand-text">/v1/transactions/history</h3>
          </div>
          <p className="text-sm text-brand-muted">
            Paginated transaction history, ordered by creation time (newest first).
          </p>
          
          <div className="space-y-3">
            <h4 className="text-xs font-medium text-brand-muted uppercase tracking-wider">Query Parameters</h4>
            <div className="overflow-hidden border border-brand-border rounded-lg">
              <table className="w-full text-left text-sm">
                <thead className="bg-brand-bg text-brand-muted text-xs uppercase">
                  <tr>
                    <th className="px-4 py-3 font-medium">Parameter</th>
                    <th className="px-4 py-3 font-medium">Type</th>
                    <th className="px-4 py-3 font-medium">Default</th>
                    <th className="px-4 py-3 font-medium">Description</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-brand-border text-brand-text bg-brand-surface">
                  <tr>
                    <td className="px-4 py-3 font-mono text-xs">limit</td>
                    <td className="px-4 py-3">integer</td>
                    <td className="px-4 py-3 text-brand-muted">50</td>
                    <td className="px-4 py-3">Number of results to return (max 100)</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-mono text-xs">offset</td>
                    <td className="px-4 py-3">integer</td>
                    <td className="px-4 py-3 text-brand-muted">0</td>
                    <td className="px-4 py-3">Number of results to skip</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-brand-muted uppercase tracking-wider">cURL Example</h4>
              <pre className="rounded-lg bg-brand-text p-4 text-sm text-brand-bg font-mono overflow-x-auto">
                <code>{`curl -X GET "https://api.agentwallet.com/v1/transactions/history?limit=10&offset=0" \\
  -H "X-API-Key: sk_live_..."`}</code>
              </pre>
            </div>
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-brand-muted uppercase tracking-wider">Response Example</h4>
              <pre className="rounded-lg bg-brand-text p-4 text-sm text-brand-bg font-mono overflow-x-auto">
                <code>{`{
  "transactions": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "intentId": "tin_abc123",
      "status": "confirmed",
      "txHash": "0x123abc...",
      "chainId": 84532,
      "createdAt": "2026-04-20T10:30:00.000Z"
    }
  ],
  "total": 42,
  "limit": 10,
  "offset": 0
}`}</code>
              </pre>
            </div>
          </div>
        </section>
      </div>

      {/* Grid of smaller reference tables */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* Supported Chains */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold font-serif text-brand-text">Supported Chains</h2>
          <div className="overflow-hidden border border-brand-border rounded-xl shadow-sm">
            <table className="w-full text-left text-sm">
              <thead className="bg-brand-bg text-brand-muted text-xs uppercase">
                <tr>
                  <th className="px-4 py-3 font-medium">Chain ID</th>
                  <th className="px-4 py-3 font-medium">Network</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-brand-border text-brand-text bg-brand-surface">
                <tr>
                  <td className="px-4 py-3 font-mono text-xs">1</td>
                  <td className="px-4 py-3">Ethereum Mainnet</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-mono text-xs">11155111</td>
                  <td className="px-4 py-3">Ethereum Sepolia (Testnet)</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-mono text-xs">8453</td>
                  <td className="px-4 py-3">Base Mainnet</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-mono text-xs">84532</td>
                  <td className="px-4 py-3">Base Sepolia (Testnet)</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-mono text-xs">137</td>
                  <td className="px-4 py-3">Polygon Mainnet (Polymarket)</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-mono text-xs">80002</td>
                  <td className="px-4 py-3">Polygon Amoy (Polymarket Testnet)</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* Error Responses */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold font-serif text-brand-text">Error Responses</h2>
          <p className="text-sm text-brand-muted">
            All API errors follow a standardized format to make programmatic handling easier.
          </p>
          <pre className="rounded-lg bg-brand-text p-4 text-sm text-brand-bg font-mono overflow-x-auto shadow-sm">
            <code>{`{
  "statusCode": 401,
  "timestamp": "2026-04-20T10:35:00.000Z",
  "path": "/v1/transactions/intent",
  "message": "Invalid API Key provided"
}`}</code>
          </pre>
        </section>
      </div>
    </div>
  );
}
