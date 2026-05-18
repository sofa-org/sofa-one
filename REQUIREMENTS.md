# Requirements

## 1. Product goal

SOFA ONE provides server-side automated blockchain signing for users who authenticate through Openfort IAM email OTP / embedded wallet. The product lets an authenticated user bind an asset wallet, authorize a backend agent signer on-chain, create API keys, and submit programmatic signing or transaction requests without exposing private keys.

## 2. Primary users

- **Dashboard user**: signs in through the web app, views wallet state, manages API keys, deposits funds, and initiates dashboard-only withdrawals.
- **API client / agent**: uses an issued API key to sign messages or submit transactions on behalf of the same user.
- **Operator / developer**: deploys the backend/frontend, manages migrations, and investigates operational failures.

## 3. Functional requirements

### 3.1 Authentication and wallet onboarding

- The backend must accept Openfort IAM bearer tokens for dashboard/user-session operations.
- `POST /auth/session` and compatibility alias `POST /auth/social` must synchronize the Openfort IAM user to a local `User` record.
- Users must be able to authorize an Openfort embedded EOA and persist Calibur agent-key registration progress per supported chain.
- `UserWallet.openfortAccountId` must remain the stable Openfort account foreign key.

### 3.2 API-key lifecycle

- Dashboard-authenticated users must be able to create, list, revoke, and refresh API keys.
- API keys must be generated as high-entropy secrets and stored only as Argon2id hashes.
- The raw API key must be returned only at creation/rotation time.
- New keys must store a 27-character lookup prefix (`sk_` + 24 hex chars); legacy shorter prefixes must remain verifiable.
- Lookup must verify every matching prefix candidate to tolerate prefix collisions.
- A user may have at most 10 active keys.
- Active key names must be non-empty and unique per user.
- Optional expiry must be bounded to a future date within 365 days.
- Optional IP allowlists must compare against `request.ip` after Express trust-proxy handling.
- Key lifecycle events must be audited.

### 3.3 Public signing API

- `POST /v1/wallets/sign` must require `X-API-Key` and reject dashboard IAM-only requests.
- Signing must use the user's Openfort-managed wallet/agent context; private keys must never leave Openfort.
- Signing requests must be audited with API-key attribution snapshots.
- Raw hash signing is disabled; supported inputs must be validated DTOs such as messages or typed data.

### 3.4 Public transaction API

- `POST /v1/transactions/send` must require `X-API-Key`.
- Requests must validate chain ID, interactions, value fields, and idempotency keys.
- The service must persist transaction records with request hashes and API-key attribution snapshots for audit/idempotency.
- `GET /v1/transactions/:id` must return only safe status fields for the owning API-key user.
- Public status responses must not include calldata, `requestHash`, or `interactionsHash`.

### 3.5 Frontend-only wallet operations

- `GET /v1/wallets/balances`, `POST /v1/wallets/deposit-info`, and `POST /v1/wallets/withdraw` must require Openfort IAM auth and frontend-origin checks.
- These endpoints must not be callable with API keys.

### 3.6 Health and operations

- The backend must expose liveness/readiness endpoints under `/health`.
- Database migrations must be managed through Prisma.
- Frontend builds must produce a static SPA suitable for static hosting.

## 4. Non-functional requirements

### Security

- Private keys must never be stored, logged, returned, or derived outside Openfort TEE-managed custody.
- Secrets must be sourced from environment variables and never committed.
- Public API and dashboard API access-control models must remain separate.
- Strict input validation must reject unknown fields.
- Production CORS must use explicit allowed origins.
- Production `TRUST_PROXY` must be explicit IP/CIDR values, never `true`/`1`.

### Reliability

- Transaction and signing attempts must persist audit records.
- Idempotency must prevent duplicate effects for repeated transaction requests with the same user/operation/chain/idempotency key.
- Openfort SDK timeout must be configurable.

### Maintainability

- Backend features must remain organized as NestJS modules.
- Public transaction functionality must stay in `TransactionsModule`; do not fold it into `WalletModule`.
- OpenAPI must describe public API-key endpoints only.
- Documentation must be updated when API boundaries, env vars, schema, or security rules change.

## 5. Supported chains

Supported chain IDs are defined in code and validated at startup/request time:

- Base Sepolia: `84532`
- Base: `8453`
- Ethereum: `1`
- Ethereum Sepolia: `11155111`
- Polygon: `137`
- Polygon Amoy: `80002`

`DEFAULT_CHAIN_ID` defaults to `84532` when unset and must be one of the supported chains.

## 6. Explicit non-goals for the current implementation

- Do not implement self-custody or local private-key derivation.
- Do not make API-key management callable by API keys.
- Do not expose frontend-only routes in `openapi.yaml`.
- Do not add speculative off-chain strategy ownership tables; agent execution authority is anchored by Calibur on-chain registration.
- Do not add webhook, queue, or notification systems unless a concrete implementation task requires them.
