import { CopyButton } from "@/components/CopyButton";
import { getApiBaseUrlForDisplay, getApiBaseUrlModeLabel } from "@/lib/api";
import { SUPPORTED_CHAINS } from "@/lib/chains";
import { DashboardPage } from "./components/DashboardPage";

const codeClass =
  "code-block rounded-xl bg-brand-text p-5 text-sm text-brand-bg overflow-x-auto shadow-sm";

const tagClass =
  "inline-flex rounded-full border border-amber-200 bg-amber-100 px-3 py-1 text-xs font-bold tracking-wide text-amber-800";

const routeSections = [
  {
    label: "Sign",
    href: "#sign",
    description: "Approved EOA typed-data signatures",
  },
  {
    label: "Send",
    href: "#send",
    description: "Backend transaction submission",
  },
  {
    label: "Status",
    href: "#status",
    description: "Safe transaction polling",
  },
];

function getNetworkEnvironment(chainName: string) {
  return /sepolia|amoy/i.test(chainName) ? "Testnet" : "Mainnet";
}

const fieldRows = {
  sign: [
    ["type", "string", "Yes", "typed_data only; message and raw hash signing are not supported."],
    ["executionMode", "string", "No", "eoa only (default). Public signing does not accept session_key."],
    ["chainId", "integer", "No", "Inferred from typedData.domain.chainId when omitted; if provided, both values must match."],
    ["typedData", "object", "Yes", "Exact supported Polygon ClobAuth, CLOB V2 single-order, or DepositWallet Batch schema, with domain.chainId, types, primaryType, and message."],
  ],
  send: [
    ["chainId", "integer", "Yes", "Supported chain ID with active Calibur authorization for the user wallet."],
    ["executionMode", "string", "No", "session_key only (default), executing from the user wallet through Calibur UserOp. eoa and unknown values return 400; no automatic conversion."],
    ["sponsorship", "string", "No", "required | none. UserOp gas sponsorship; defaults to none."],
    ["interactions", "array", "Yes", "At least one contract interaction."],
    ["└ to", "string", "Yes", "Target Ethereum address."],
    ["└ data", "string", "Yes", "0x-prefixed calldata, max 64 KB."],
    ["└ value", "string", "No", "Wei amount as a decimal string. Defaults to \"0\"."],
    ["idempotencyKey", "string", "Yes", "Max 64 characters: letters, numbers, _ and -."],
  ],
  status: [
    ["transactionId", "path", "Yes", "SOFA ONE transaction UUID returned by /v1/transactions."],
  ],
};

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className={codeClass}>
      <code>{children}</code>
    </pre>
  );
}

function CopyableCodeBlock({
  children,
  label = "Example",
}: {
  children: string;
  label?: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">
          {label}
        </span>
        <CopyButton text={children} className="shrink-0" />
      </div>
      <CodeBlock>{children}</CodeBlock>
    </div>
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
  id,
  children,
}: {
  path: string;
  method?: "GET" | "POST";
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-24 relative overflow-hidden rounded-2xl border border-brand-border bg-white p-7 shadow-xl ring-1 ring-black/5"
    >
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
  const apiBaseUrl = getApiBaseUrlForDisplay();
  const apiBaseUrlMode = getApiBaseUrlModeLabel();
  const apiKeyHeader = 'X-API-Key: sk_<64-hex-chars>';
  const statusQuickStart = `curl ${apiBaseUrl}/v1/transactions/TRANSACTION_ID \\
  -H "X-API-Key: sk_your_key_here" \\
  -H "User-Agent: my-service/1.0"`;
  const signExample = `curl -X POST ${apiBaseUrl}/v1/wallets/sign \\
  -H "X-API-Key: sk_your_key_here" \\
  -H "Content-Type: application/json" \\
  -H "User-Agent: my-service/1.0" \\
  -d '{
    "type": "typed_data",
    "chainId": 137,
    "executionMode": "eoa",
    "typedData": {
      "domain": { "name": "ClobAuthDomain", "version": "1", "chainId": 137 },
      "types": {
        "ClobAuth": [
          { "name": "address", "type": "address" },
          { "name": "timestamp", "type": "string" },
          { "name": "nonce", "type": "uint256" },
          { "name": "message", "type": "string" }
        ]
      },
      "primaryType": "ClobAuth",
      "message": {
        "address": "<selected wallet signerAddress>",
        "timestamp": "<current Unix seconds as canonical decimal string>",
        "nonce": 0,
        "message": "This message attests that I control the given wallet"
      }
    }
  }'`;
  const sendExample = `curl -X POST ${apiBaseUrl}/v1/transactions \\
  -H "X-API-Key: sk_your_key_here" \\
  -H "Content-Type: application/json" \\
  -H "User-Agent: my-service/1.0" \\
  -d '{
    "chainId": 84532,
    "executionMode": "session_key",
    "sponsorship": "none",
    "interactions": [{
      "to": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "data": "0xa9059cbb0000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000000f4240",
      "value": "0"
    }],
    "idempotencyKey": "order-123"
  }'`;
  const statusExample = `curl ${apiBaseUrl}/v1/transactions/550e8400-e29b-41d4-a716-446655440000 \\
  -H "X-API-Key: sk_your_key_here" \\
  -H "User-Agent: my-service/1.0"`;

  return (
    <DashboardPage
      title="API Documentation"
      description="Sign approved typed data and submit contract interactions from your backend. Private keys stay inside Openfort TEE infrastructure and are never returned to clients."
      tags={
        <>
          <span className="rounded-full bg-brand-accent/10 px-3 py-1 text-xs font-bold uppercase tracking-widest text-brand-accent">
            Public API
          </span>
          <span className="rounded-full bg-brand-bg px-3 py-1 text-xs font-medium text-brand-muted">
            TEE-managed wallet signing
          </span>
        </>
      }
    >
      <section className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-brand-border bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-bold uppercase tracking-widest text-brand-muted">Base URL</p>
            <span className="rounded-full bg-brand-bg px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted">
              {apiBaseUrlMode}
            </span>
          </div>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="font-mono text-sm text-brand-text">{apiBaseUrl}</p>
            <CopyButton text={apiBaseUrl} className="w-fit shrink-0" />
          </div>
          <p className="mt-3 text-xs leading-5 text-brand-muted">
            {apiBaseUrlMode === 'Vite proxy'
              ? 'Local examples route through the Vite /api proxy.'
              : 'Examples use the deployed API URL from VITE_API_URL.'}
          </p>
        </div>
        <div className="rounded-2xl border border-brand-border bg-white p-5 shadow-sm md:col-span-2">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-brand-muted">Authentication</p>
              <p className="mt-2 text-sm leading-6 text-brand-muted">
                Use <code className="rounded bg-brand-accent/10 px-1.5 py-0.5 font-mono text-xs text-brand-accent">X-API-Key</code> for public API requests. Each key is permanently bound to the wallet selected when it was created; the request cannot switch to another wallet. Create a separate key for each wallet you use. POST JSON requests also use <code>Content-Type: application/json</code>. Optional <code>User-Agent</code> is a spoofable signal, not authentication; it may be recorded/saved for security audit and anomaly detection and compared exactly with prior context. curl/SDK/deployment changes can change it. Keep it stable and treat changes as security events, but never rely on its secrecy. Under high-risk key permission/risk checks, a single UA/IP context change may alert or freeze a key. If frozen, never disclose the key: create a replacement in Dashboard, update your backend secret, revoke the old key, and follow the existing recovery process. UA is not required on every endpoint. Dashboard access uses SOFA session cookies; Openfort bearer identity is used only for login exchange and fresh wallet authorization. Neither substitutes for a public API key.
              </p>
            </div>
            <CopyButton text={apiKeyHeader} className="w-fit shrink-0" />
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-brand-border bg-white p-5 text-sm leading-6 text-brand-muted shadow-sm">
        <h2 className="mb-2 font-semibold text-brand-text">Wallet Address and Signer Address</h2>
        <p>
          Wallet projections and signing responses use <code>walletAddress</code> for your selected user wallet,
          unchanged by EIP-7702 delegation to Calibur, and <code>signerAddress</code> for the TEE-managed EOA.
          A signer address alone does not establish authorization; per-network status and existing live policies still apply.
        </p>
        <p className="mt-2">
          Breaking response change: <code>signerAddress</code> replaces <code>agentWalletAddress</code> without an alias.
          Signing responses no longer duplicate the signer into <code>walletAddress</code>; use <code>signerAddress</code> for signature recovery and ClobAuth.
          Transaction status/history and signing-request audit addresses remain exactly as recorded, not reinterpreted as the current user wallet.
        </p>
      </section>

      <section className="rounded-2xl border border-brand-border bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-widest text-brand-muted">
              Route map
            </p>
            <h2 className="mt-1 font-serif text-xl font-bold text-brand-text">
              Jump to the integration surface you need
            </h2>
          </div>
          <p className="max-w-xl text-sm leading-6 text-brand-muted">
            Public backend routes use <span className="font-mono text-brand-text">X-API-Key</span>.
          </p>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {routeSections.map((section) => (
            <a
              key={section.href}
              href={section.href}
              className="rounded-xl border border-brand-border bg-brand-bg/50 p-4 transition hover:border-brand-text hover:bg-white"
            >
              <span className="text-sm font-semibold text-brand-text">
                {section.label}
              </span>
              <span className="mt-1 block text-xs leading-5 text-brand-muted">
                {section.description}
              </span>
            </a>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-brand-border bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-widest text-brand-muted">
              Supported networks
            </p>
            <h2 className="mt-1 font-serif text-xl font-bold text-brand-text">
              Pick a chain ID your wallet has authorized
            </h2>
          </div>
          <p className="max-w-xl text-sm leading-6 text-brand-muted">
            Use these chain IDs in public requests. Testnets include faucet help in the
            wallet setup flow; mainnets require funding the EOA with real native gas.
          </p>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {SUPPORTED_CHAINS.map((chain) => (
            <div
              key={chain.id}
              className="rounded-xl border border-brand-border bg-brand-bg/50 p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-brand-text">{chain.name}</p>
                  <p className="mt-1 font-mono text-xs text-brand-muted">chainId: {chain.id}</p>
                </div>
                <span className="rounded-full bg-white px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted">
                  {getNetworkEnvironment(chain.name)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <CodeBlock>{apiKeyHeader}</CodeBlock>

      <section className="rounded-2xl border border-brand-border bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-widest text-brand-muted">Quick action</p>
            <h2 className="mt-2 font-serif text-xl font-bold text-brand-text">
              Check a transaction from your backend
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-brand-muted">
              After calling <span className="font-mono text-brand-text">/v1/transactions</span>, store the
              returned transaction ID and poll the safe status endpoint. The response omits calldata and request
              hashes, so it is safe for backend logs and customer support tooling.
            </p>
          </div>
        </div>
        <div className="mt-5">
          <CopyableCodeBlock label="Status request">{statusQuickStart}</CopyableCodeBlock>
        </div>
      </section>

      <div className="space-y-8">
        <EndpointCard id="sign" path="/v1/wallets/sign">
          <p className="text-sm leading-6 text-brand-muted">
            Sign only approved Polygon EIP-712 typed data: exact Polymarket ClobAuth bootstrap, CLOB V2 single orders, or verified DepositWallet Batch payloads. All use the TEE signer&apos;s plain EOA signature (<code>executionMode: &quot;eoa&quot;</code>, default). Message, raw hash, and session-key signing are not supported; no transaction is broadcast. Each lane requires <code>canSign</code>, <code>canUseEoaExecution</code>, its active capability grant, and all independent policy checks. For ClobAuth, set <code>message.address</code> to <code>signerAddress</code> from <code>GET /v1/wallets</code>, not <code>walletAddress</code>; supply the current canonical Unix timestamp (±300 seconds).
          </p>

          <div className="space-y-3">
            <h4 className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">Request body</h4>
            <FieldTable rows={fieldRows.sign} />
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <CopyableCodeBlock>{signExample}</CopyableCodeBlock>
            </div>
            <div className="space-y-2">
              <h4 className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">200 response</h4>
              <CodeBlock>{`{
  "signature": "0x5d99b6f7...",
  "walletAddress": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
  "signerAddress": "0x1111111111111111111111111111111111111111",
  "type": "typed_data",
  "executionMode": "eoa"
}`}</CodeBlock>
            </div>
          </div>
        </EndpointCard>

        <EndpointCard id="send" path="/v1/transactions">
          <p className="text-sm leading-6 text-brand-muted">
            Submit one or more contract interactions using an API key. Only <code>executionMode: &quot;session_key&quot;</code> is accepted; omitting it keeps the same default. Execution uses the user&apos;s EIP-7702 delegated wallet via the chain-authorized TEE signer and Calibur UserOp. An explicit <code>&quot;eoa&quot;</code> or unknown mode returns HTTP 400, never an automatic conversion. Direct signer EOA transaction sends are not supported; the independent approved Polymarket signing endpoint remains available. Set <code>sponsorship: &quot;required&quot;</code> only when a paymaster policy is configured; otherwise keep the default <code>&quot;none&quot;</code>. Openfort IAM bearer tokens are not accepted here.
          </p>

          <div className="space-y-3">
            <h4 className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">Request body</h4>
            <FieldTable rows={fieldRows.send} />
          </div>

          <div className="rounded-xl border border-brand-border bg-brand-bg/60 p-4 text-sm leading-6 text-brand-muted">
            Idempotency is required: reusing the same key with the same request returns the existing transaction; reusing it with a different request returns <span className="font-mono text-brand-text">400</span>.
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <CopyableCodeBlock>{sendExample}</CopyableCodeBlock>
            </div>
            <div className="space-y-2">
              <h4 className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">201 response</h4>
              <CodeBlock>{`{
  "transactionId": "550e8400-e29b-41d4-a716-446655440000",
  "transactionHash": null,
  "status": "pending"
}`}</CodeBlock>
              <p className="text-xs leading-5 text-brand-muted">
                Status may be submitting, pending, confirmed, failed, or unknown. The transaction hash is null while submission is pending or not yet known.
              </p>
            </div>
          </div>
        </EndpointCard>

        <EndpointCard id="status" path="/v1/transactions/:id" method="GET">
          <p className="text-sm leading-6 text-brand-muted">
            Query a safe status view for transactions created through the public send endpoint. The response excludes calldata, request hashes, and interaction hashes. Its <code>walletAddress</code> remains the persisted execution address: the user wallet for session-key execution or the TEE signer for historical EOA execution, not a current wallet identity projection.
          </p>

          <div className="space-y-3">
            <h4 className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">Path params</h4>
            <FieldTable rows={fieldRows.status} />
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <CopyableCodeBlock>{statusExample}</CopyableCodeBlock>
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
              <p className="text-xs leading-5 text-brand-muted">
                <span className="font-mono text-brand-text">failureReason</span> is populated only for failed transactions, while <span className="font-mono text-brand-text">completedAt</span> is set when the transaction reaches a final state.
              </p>
            </div>
          </div>
        </EndpointCard>
      </div>

      <section className="grid gap-6 md:grid-cols-2">
        <div className="rounded-2xl border border-brand-border bg-white p-6 shadow-sm">
          <h2 className="mb-3 font-serif text-xl font-bold text-brand-text">Validation</h2>
          <ul className="space-y-2 text-sm leading-6 text-brand-muted">
            <li>• Unknown request properties are rejected.</li>
            <li>• Transaction chain IDs must be supported with active Calibur authorization for the user wallet.</li>
            <li>• Transaction executionMode accepts only session_key or omission; eoa and unknown modes return HTTP 400.</li>
          </ul>
        </div>
        <div className="rounded-2xl border border-brand-border bg-white p-6 shadow-sm">
          <h2 className="mb-3 font-serif text-xl font-bold text-brand-text">Error format</h2>
          <CodeBlock>{`{
  "statusCode": 401,
  "code": "INVALID_API_KEY",
  "message": "Invalid API key",
  "requestId": "req_...",
  "timestamp": "2026-04-20T10:35:00.000Z",
  "path": "/v1/transactions"
}`}</CodeBlock>
          <p className="mt-3 text-sm leading-6 text-brand-muted">
            Validation failures use <span className="font-mono text-brand-text">VALIDATION_ERROR</span> and include a <span className="font-mono text-brand-text">details</span> array. Common codes include <span className="font-mono text-brand-text">API_KEY_REQUIRED</span>, <span className="font-mono text-brand-text">INVALID_API_KEY</span>, <span className="font-mono text-brand-text">CHAIN_NOT_SUPPORTED</span>, <span className="font-mono text-brand-text">IP_NOT_ALLOWED</span>, and <span className="font-mono text-brand-text">IDEMPOTENCY_CONFLICT</span>.
          </p>
          <p className="mt-3 text-sm leading-6 text-brand-muted">
            Include the <span className="font-mono text-brand-text">requestId</span> value in support tickets and backend logs so SOFA ONE can trace the exact failed request without exposing API keys or transaction calldata.
          </p>
        </div>
      </section>
    </DashboardPage>
  );
}
