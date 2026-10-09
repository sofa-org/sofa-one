# Security

## 1. Security invariants

- Private keys must never be stored, logged, returned, exported, or derived by this application.
- Openfort TEE-managed custody is the only signing boundary.
- API-key secrets are stored only as Argon2id hashes; plaintext secrets exist only at generation time and in the caller's possession.
- Public API-key endpoints and dashboard IAM endpoints are separate trust domains.
- API keys must never manage API keys.
- Public status responses must not disclose calldata, `requestHash`, `interactionsHash`, private Openfort identifiers, or raw request payloads.

## 2. Authentication surfaces

### Dashboard/Openfort IAM

Used for user-facing dashboard operations:

- session sync and `GET /auth/me`
- embedded wallet authorization and registration-result tracking
- API-key lifecycle
- balances, deposit info, and withdrawals

Frontend-only endpoints must use Openfort IAM bearer auth plus `FrontendOnlyGuard` origin/referer checks.

### Public API key

Used only for automation/client integrations:

- `POST /v1/wallets/sign`
- `POST /v1/transactions/send`
- `GET /v1/transactions/:id`

These endpoints require `X-API-Key` and must reject IAM-only dashboard auth.

## 3. API-key storage and verification

- Generate secrets with sufficient entropy.
- Store `apiKeyHash` as Argon2id output, never SHA-only or plaintext.
- Store `keyPrefix` only as a lookup hint.
- For lookup, fetch all non-revoked candidates with the submitted prefix and Argon2-verify every candidate.
- Treat prefix collisions and legacy short prefixes as expected cases.
- Return raw API keys only once when created/refreshed.
- Audit create/revoke/rotate operations in `ApiKeyEvent`.

## 4. IP allowlists and proxy safety

- Compare IP allowlists against Express `request.ip` only.
- Do not parse raw `X-Forwarded-For` in application code.
- In production, configure `TRUST_PROXY` as explicit trusted proxy IP/CIDR values.
- Do not set `TRUST_PROXY=true`, `1`, or a hop count.

## 5. CORS and frontend-only protection

- `CORS_ORIGIN` is required in production.
- Development defaults allow `http://localhost:3000` and `http://localhost:3100`.
- Frontend-only guards are defense-in-depth for browser-facing operations, not a replacement for bearer-token auth.
- Do not add frontend-only guards to public API-key endpoints because public API clients may not have browser origin headers.

## 6. Validation and payload limits

- Global validation rejects unknown fields (`forbidNonWhitelisted: true`).
- DTOs must validate Ethereum addresses, chain IDs, interaction arrays, idempotency keys, and decimal string values explicitly.
- Request bodies are limited to `100kb`.
- Do not accept arbitrary raw hashes for signing unless a future security review approves it.
- API-key signing permits the exact Polymarket CLOB `ClobAuth` bootstrap typed data and the separately scoped V2 order exception below: EOA mode,
  Polygon chain 137, exact `ClobAuthDomain` version 1 domain (no verifyingContract/salt),
  exact ordered `ClobAuth` fields and fixed message, selected agentWalletAddress (never the
  embedded wallet address or funder), canonical decimal Unix timestamp within ±300 seconds,
  and uint256 nonce (zero allowed). Optional EIP712Domain declaration must exactly contain
  name:string, version:string, chainId:uint256. ClobAuth itself is not order, Permit, arbitrary
  typed/message/hash, or session-key signing.
- ClobAuth eligibility requires `canSign`, `canUseEoaExecution`, and either `capabilityMode: all`
  or `capabilityMode: custom` containing `polymarket:137:clob-auth:v1`. `all` dynamically
  includes active, unpaused reviewed capabilities, but never bypasses permissions, chain,
  schema, scope, freeze, pause, destination, or other independent controls. `custom` grants
  only exact IDs; `[]` denies catalog capabilities. Preserve EOA
  isolation (IP/TTL/rate), destination allowlist/protection, risk/signing-policy, frozen/live
  key and final grant/pause/digest acceptance checks. The final live-state read does not
  serialize against concurrent freeze writers; do not promise race-free freeze exclusion.
  PostgreSQL race behavior and live Openfort/Polymarket outcomes remain unverified.
  Destination protection blocks signing.
  The exception does not imply deployment or successful live Polymarket authentication.
- Generic API-key transaction sends require active, granted DeFi capability matches for
  every contract call. Unknown/paused/ungranted capabilities fail closed. Capability/pause
  state is revalidated in the acceptance transaction; do not make RPC/Openfort/HTTP calls
  while policy locks are held.
- DeFi grants authorize exact catalog functions, not safe financial outcomes: callers control
  ABI arguments and payable value. ERC-20 approval is an independent explicit grant allowing
  any spender and any uint256 amount, including unlimited approval; never auto-grant or
  automatically clean it up. Catalog admission does not grant authority. Preserve the
  independent identity, permission, freeze, session/EOA, destination, billing, simulation,
  idempotency, and user-configured key-spend controls.
- Existing grant IDs intentionally gain the simplified function-level scope without a schema
  migration. Owners should review existing grants and revoke/re-grant if the broader
  authority is not intended.

### Polymarket CLOB V2 order-signing safeguards

The separate order exception requires explicit custom grant `polymarket:137:clob-order:v2` (`all` never grants it), EOA mode and permissions, exact `TypedDataSign`/11-field V2 Order and six-field wrapper, fixed ordinary (`0xE111180000d2663C0091e4f400237545B87B996B`) or neg-risk (`0xe2222d279d744050d28e00520010520000310F59`) exchange, and DepositWallet `signatureType:3` (POLY_1271). Reject V1/V3, types 0/1/2, arbitrary typed data, messages, and permits. Existing permission and EOA safeguards remain; strict protocol validation, Polygon chain/runtime-code presence and stability checks, agent-signature recovery, and ERC-1271 validity are required. These checks do not prove official-wallet ownership or automatically recognize an official factory. Wallet-scoped rolling 60-second limit: at most 60 accepted orders across keys, atomically reserved; failures consume reservations. This does not alter general EOA enabled/permission/IP/TTL controls or the shared original 1/60s ClobAuth/send limit. Amounts must be positive and structure valid, but there are no economic/market/price/quantity limits. ±300000ms is service signing freshness, not exchange expiry. Freeze/pause/revocation cannot revoke signed orders; failure may mean TEE signing occurred without returning the signature. Real-client/CLOB/DepositWallet end-to-end acceptance remains unverified.

## 7. Logging rules

Never log:

- `OPENFORT_API_KEY`
- `OPENFORT_WALLET_SECRET`
- raw API keys
- authorization headers
- private keys or seed material
- full transaction calldata for public status responses
- raw signing messages when not required for debugging

Safe to log with care:

- request IDs
- user IDs
- API-key prefixes
- transaction IDs
- chain IDs
- high-level statuses and error codes

## 8. Environment secrets

Required backend secrets/config:

- `OPENFORT_API_KEY`
- `OPENFORT_WALLET_SECRET`
- `DATABASE_URL`
- `CORS_ORIGIN` in production
- `TRUST_PROXY` in production

Optional/backend config:

- `OPENFORT_PUBLISHABLE_KEY`
- `OPENFORT_TIMEOUT_MS`
- `REDIS_URL`
- `DEFAULT_CHAIN_ID`

Frontend variables must be browser-safe only. Never expose backend secrets through `VITE_*` variables.

## 9. Incident response checklist

If an API key may be compromised:

1. Revoke the key or refresh all active keys for that user.
2. Review `ApiKeyEvent`, `SigningRequest`, and `Transaction` rows for the affected prefix/user.
3. Check IP allowlist and last-used timestamps.
4. Rotate any exposed deployment logs containing sensitive headers.

If Openfort secrets may be compromised:

1. Rotate secrets in Openfort and deployment secret stores.
2. Restart backend instances with new environment values.
3. Review logs for evidence of secret exposure.
4. Pause public API traffic if signing integrity cannot be guaranteed.
