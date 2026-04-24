export default function APIDocsPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-12 pb-24 pt-8">
      {/* Header */}
      <div className="space-y-4">
        <h1 className="text-3xl font-bold font-serif text-brand-text">
          API Documentation
        </h1>
        <p className="text-base text-brand-muted max-w-2xl">
          Welcome to the SOFA ONE API. This reference provides the 2 public endpoints needed to programmatically sign data and submit transaction intents via your TEE-secured backend wallet.
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
  -d '{"type":"message","message":"Hello, SOFA ONE!"}'`}</code>
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
            <h3 className="text-lg font-mono font-semibold text-brand-text">/v1/transactions/send</h3>
          </div>
          <p className="text-sm text-brand-muted">
            Submit one or more raw contract interactions from your TEE-secured backend wallet. Server handles signing and gas.
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
                    <td className="px-4 py-3">integer</td>
                    <td className="px-4 py-3 text-brand-accent">Yes</td>
                    <td className="px-4 py-3">Target chain ID (e.g. 84532 for Base Sepolia)</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-mono text-xs">interactions</td>
                    <td className="px-4 py-3">array</td>
                    <td className="px-4 py-3 text-brand-accent">Yes</td>
                    <td className="px-4 py-3">Array of interaction objects (min 1)</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-mono text-xs">└ to</td>
                    <td className="px-4 py-3">string</td>
                    <td className="px-4 py-3 text-brand-accent">Yes</td>
                    <td className="px-4 py-3">0x-prefixed target contract address</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-mono text-xs">└ data</td>
                    <td className="px-4 py-3">string</td>
                    <td className="px-4 py-3 text-brand-accent">Yes</td>
                    <td className="px-4 py-3">ABI-encoded calldata (0x-prefixed hex)</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-mono text-xs">└ value</td>
                    <td className="px-4 py-3">string</td>
                    <td className="px-4 py-3 text-brand-muted">No</td>
                    <td className="px-4 py-3">Value in wei as decimal string (default "0")</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-mono text-xs">policyId</td>
                    <td className="px-4 py-3">string</td>
                    <td className="px-4 py-3 text-brand-muted">No</td>
                    <td className="px-4 py-3">Openfort gas sponsorship policy ID</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-mono text-xs">idempotencyKey</td>
                    <td className="px-4 py-3">string</td>
                    <td className="px-4 py-3 text-brand-muted">No</td>
                    <td className="px-4 py-3">Unique key to prevent duplicate submissions</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-brand-muted uppercase tracking-wider">cURL Example</h4>
              <pre className="rounded-lg bg-brand-text p-4 text-sm text-brand-bg font-mono overflow-x-auto">
                <code>{`curl -X POST https://api.agentwallet.com/v1/transactions/send \\
  -H "X-API-Key: sk_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "chainId": 84532,
    "interactions": [{
      "to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "data": "0xa9059cbb000000000000000000000000RecipientAddr00000000000000000000000000000000000000000000000000000000000f4240",
      "value": "0"
    }],
    "idempotencyKey": "order-123"
  }'`}</code>
              </pre>
            </div>
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-brand-muted uppercase tracking-wider">Response Example</h4>
              <pre className="rounded-lg bg-brand-text p-4 text-sm text-brand-bg font-mono overflow-x-auto">
                <code>{`{
  "transactionId": "550e8400-e29b-41d4-a716-446655440000",
  "transactionHash": "0xabc123...",
  "status": "confirmed"
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
