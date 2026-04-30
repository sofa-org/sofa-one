const codeClass =
  "rounded-xl bg-brand-text p-5 text-sm text-brand-bg font-mono overflow-x-auto shadow-sm";

const tagClass =
  "inline-flex rounded-full border border-amber-200 bg-amber-100 px-3 py-1 text-xs font-bold tracking-wide text-amber-800";

const fieldRows = {
  sign: [
    ["type", "string", "Yes", "message | typed_data"],
    ["chainId", "integer", "Yes", "Supported chain ID. Must be allowed by the API key."],
    ["message", "string | object", "Cond.", "Required for message. Non-empty text or { raw: \"0x...\" } with even-length hex bytes."],
    ["typedData", "object", "Cond.", "Required for typed_data. Must include domain, types, primaryType, and message."],
  ],
  send: [
    ["chainId", "integer", "Yes", "Supported chain ID. Must be allowed by the API key."],
    ["interactions", "array", "Yes", "At least one contract interaction."],
    ["└ to", "string", "Yes", "Target Ethereum address."],
    ["└ data", "string", "Yes", "0x-prefixed calldata, max 64 KB."],
    ["└ value", "string", "No", "Wei amount as a decimal string. Defaults to \"0\"."],
    ["policyId", "string", "No", "User-owned Openfort policy ID."],
    ["idempotencyKey", "string", "Yes", "Max 64 characters: letters, numbers, _ and -."],
  ],
  status: [
    ["transactionId", "path", "Yes", "SOFA ONE transaction UUID returned by /v1/transactions/send."],
  ],
};

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className={codeClass}>
      <code>{children}</code>
    </pre>
  );
}

function FieldTable({ rows }: { rows: string[][] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-brand-border shadow-sm">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="bg-brand-bg text-xs uppercase text-brand-muted">
          <tr>
            <th className="px-4 py-3 font-medium">Field</th>
            <th className="px-4 py-3 font-medium">Type</th>
            <th className="px-4 py-3 font-medium">Required</th>
            <th className="px-4 py-3 font-medium">Notes</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-brand-border bg-white text-brand-text">
          {rows.map(([field, type, required, notes]) => (
            <tr key={field}>
              <td className="px-4 py-3 font-mono text-xs">{field}</td>
              <td className="px-4 py-3 text-brand-muted">{type}</td>
              <td
                className={`px-4 py-3 font-medium ${
                  required === "Yes" ? "text-brand-accent" : "text-brand-muted"
                }`}
              >
                {required}
              </td>
              <td className="px-4 py-3">{notes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EndpointCard({
  path,
  method = "POST",
  children,
}: {
  path: string;
  method?: "GET" | "POST";
  children: React.ReactNode;
}) {
  return (
    <section className="relative overflow-hidden rounded-2xl border border-brand-border bg-white p-7 shadow-xl ring-1 ring-black/5">
      <div className="absolute left-0 top-0 h-1.5 w-full bg-brand-text" />
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <span className={tagClass}>{method}</span>
        <h3 className="font-mono text-lg font-semibold text-brand-text">{path}</h3>
      </div>
      <div className="space-y-6">{children}</div>
    </section>
  );
}

export default function APIDocsPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-10 pb-16">
      <header className="rounded-3xl border border-brand-border bg-white p-8 shadow-xl ring-1 ring-black/5">
        <div className="mb-4 flex flex-wrap gap-2">
          <span className="rounded-full bg-brand-accent/10 px-3 py-1 text-xs font-bold uppercase tracking-widest text-brand-accent">
            Public API
          </span>
          <span className="rounded-full bg-brand-bg px-3 py-1 text-xs font-medium text-brand-muted">
            TEE-managed wallet signing
          </span>
        </div>
        <h1 className="mb-3 font-serif text-3xl font-bold text-brand-text">
          API Documentation
        </h1>
        <p className="max-w-3xl text-sm leading-6 text-brand-muted">
          Sign messages and submit contract interactions from your SOFA ONE backend wallet. Private keys stay inside Openfort TEE infrastructure and are never returned to clients.
        </p>
      </header>

      <section className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-brand-border bg-white p-5 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-widest text-brand-muted">Base URL</p>
          <p className="mt-2 font-mono text-sm text-brand-text">https://api.agentwallet.com</p>
        </div>
        <div className="rounded-2xl border border-brand-border bg-white p-5 shadow-sm md:col-span-2">
          <p className="text-xs font-bold uppercase tracking-widest text-brand-muted">Authentication</p>
          <p className="mt-2 text-sm leading-6 text-brand-muted">
            Use <code className="rounded bg-brand-accent/10 px-1.5 py-0.5 font-mono text-xs text-brand-accent">X-API-Key</code> for public API requests. Clerk bearer tokens are only accepted by frontend-only dashboard endpoints.
          </p>
        </div>
      </section>

      <CodeBlock>{`X-API-Key: sk_live_...`}</CodeBlock>

      <div className="space-y-8">
        <EndpointCard path="/v1/wallets/sign">
          <p className="text-sm leading-6 text-brand-muted">
            Sign a message or EIP-712 typed data through the user&apos;s authorized backend agent wallet/session key. The returned signature is a Calibur wrapped signature <code>abi.encode(keyHash, agentSignature, hookData)</code>, so verifiers should call ERC-1271 <code>isValidSignature</code> on the embedded wallet address. Raw hash signing is disabled for safety and no transaction is broadcast.
          </p>

          <div className="space-y-3">
            <h4 className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">Request body</h4>
            <FieldTable rows={fieldRows.sign} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <h4 className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">Example</h4>
              <CodeBlock>{`curl -X POST https://api.agentwallet.com/v1/wallets/sign \\
  -H "X-API-Key: sk_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "type": "message",
    "chainId": 84532,
    "message": "Hello, SOFA ONE!"
  }'`}</CodeBlock>
            </div>
            <div className="space-y-2">
              <h4 className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">200 response</h4>
              <CodeBlock>{`{
  "signature": "0x5d99b6f7...",
  "walletAddress": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
  "signerAddress": "0x1111111111111111111111111111111111111111",
  "type": "message"
}`}</CodeBlock>
            </div>
          </div>
        </EndpointCard>

        <EndpointCard path="/v1/transactions/send">
          <p className="text-sm leading-6 text-brand-muted">
            Submit one or more contract interactions from the user&apos;s active backend wallet using an API key. The server handles wallet signing and policy checks; Clerk bearer tokens are not accepted here.
          </p>

          <div className="space-y-3">
            <h4 className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">Request body</h4>
            <FieldTable rows={fieldRows.send} />
          </div>

          <div className="rounded-xl border border-brand-border bg-brand-bg/60 p-4 text-sm leading-6 text-brand-muted">
            Idempotency is required: reusing the same key with the same request returns the existing transaction; reusing it with a different request returns <span className="font-mono text-brand-text">400</span>.
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <h4 className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">Example</h4>
              <CodeBlock>{`curl -X POST https://api.agentwallet.com/v1/transactions/send \\
  -H "X-API-Key: sk_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "chainId": 84532,
    "interactions": [{
      "to": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "data": "0xa9059cbb...",
      "value": "0"
    }],
    "idempotencyKey": "order-123"
  }'`}</CodeBlock>
            </div>
            <div className="space-y-2">
              <h4 className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">201 response</h4>
              <CodeBlock>{`{
  "transactionId": "550e8400-e29b-41d4-a716-446655440000",
  "transactionHash": "0xabc123...",
  "status": "pending"
}`}</CodeBlock>
              <p className="text-xs leading-5 text-brand-muted">
                Status may be pending, submitting, confirmed, or failed. The transaction hash can be empty while submission is pending.
              </p>
            </div>
          </div>
        </EndpointCard>

        <EndpointCard path="/v1/transactions/:id" method="GET">
          <p className="text-sm leading-6 text-brand-muted">
            Query a safe transaction status view for the API-key user. The response excludes calldata, request hashes, and interaction hashes.
          </p>

          <div className="space-y-3">
            <h4 className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">Path params</h4>
            <FieldTable rows={fieldRows.status} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <h4 className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">Example</h4>
              <CodeBlock>{`curl https://api.agentwallet.com/v1/transactions/550e8400-e29b-41d4-a716-446655440000 \
  -H "X-API-Key: sk_live_..."`}</CodeBlock>
            </div>
            <div className="space-y-2">
              <h4 className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">200 response</h4>
              <CodeBlock>{`{
  "transactionId": "550e8400-e29b-41d4-a716-446655440000",
  "transactionHash": "0xabc123...",
  "status": "confirmed",
  "chainId": 84532,
  "walletAddress": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
  "failureReason": null,
  "createdAt": "2026-04-28T10:00:00.000Z",
  "completedAt": "2026-04-28T10:00:10.000Z"
}`}</CodeBlock>
            </div>
          </div>
        </EndpointCard>
      </div>

      <section className="grid gap-6 md:grid-cols-2">
        <div className="rounded-2xl border border-brand-border bg-white p-6 shadow-sm">
          <h2 className="mb-3 font-serif text-xl font-bold text-brand-text">Validation</h2>
          <ul className="space-y-2 text-sm leading-6 text-brand-muted">
            <li>• Unknown request properties are rejected.</li>
            <li>• Chain IDs must be supported and allowed for the API key.</li>
            <li>• Wallets must exist and be active before sending transactions.</li>
          </ul>
        </div>
        <div className="rounded-2xl border border-brand-border bg-white p-6 shadow-sm">
          <h2 className="mb-3 font-serif text-xl font-bold text-brand-text">Error format</h2>
          <CodeBlock>{`{
  "statusCode": 401,
  "code": "INVALID_API_KEY",
  "message": "Invalid API key",
  "timestamp": "2026-04-20T10:35:00.000Z",
  "path": "/v1/transactions/send"
}`}</CodeBlock>
          <p className="mt-3 text-sm leading-6 text-brand-muted">
            Validation failures use <span className="font-mono text-brand-text">VALIDATION_ERROR</span> and include a <span className="font-mono text-brand-text">details</span> array. Common codes include <span className="font-mono text-brand-text">API_KEY_REQUIRED</span>, <span className="font-mono text-brand-text">CHAIN_NOT_ALLOWED</span>, and <span className="font-mono text-brand-text">IDEMPOTENCY_CONFLICT</span>.
          </p>
        </div>
      </section>
    </div>
  );
}
