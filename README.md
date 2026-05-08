# SOFA ONE

Server-side automated blockchain signing for users authenticated with Openfort email OTP. Users connect an Openfort embedded EOA, authorize a backend agent signer on-chain, and create API keys for programmatic transaction submission.

## Architecture

```
[User Client]
   ↓ Openfort email OTP + embedded wallet
[Frontend — Vite + React SPA + Openfort]
   ↓ HTTPS + Openfort IAM token
[Backend — NestJS]
   ├── Auth Module        (Openfort IAM session sync + embedded EOA authorization)
   ├── Wallet Module      (Openfort SDK — signing, balances, deposits, withdrawals)
   ├── Transaction Module (Calibur agent UserOperation submission)
   └── API Key Module     (generation, validation, rotation, revocation)
   ↓
[Openfort SDK → TEE]     [PostgreSQL + Redis]     [EVM Chains]
  Private key custody      User/wallet/key store    Base · Ethereum
```

### Key Properties

- **Private keys never leave the TEE** — all signing happens inside Openfort / AWS Nitro Enclaves.
- **Split auth** — public signing/transaction APIs require `X-API-Key`; dashboard-only APIs require an Openfort IAM bearer token plus frontend-origin checks.
- **API keys hashed with Argon2** — never stored in plaintext; a 27-character lookup prefix (`sk_` + 24 hex chars) is stored for DB lookup, and every prefix candidate is hash-verified to tolerate collisions/legacy keys.
- **On-chain agent authorization** — Backend Agent Wallet execution is governed by the Calibur key registry rather than an off-chain policy table.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vite 6, React 19, React Router 7, Tailwind CSS 4, Openfort React SDK |
| Backend | NestJS 10, TypeScript 5 |
| Wallet Core | Openfort Node SDK |
| Database | PostgreSQL 16, Prisma 5 |
| Cache / Queue | Redis 7, BullMQ (Phase 2) |
| Chains | Base (8453), Ethereum (1), Base Sepolia (84532), Ethereum Sepolia (11155111), Polygon (137), Polygon Amoy (80002) |

## Prerequisites

- **Node.js** ≥ 20
- **Docker** (for PostgreSQL + Redis)
- **Openfort** account — [openfort.io](https://www.openfort.io)

## Getting Started

### 1. Clone and install

```bash
git clone <repo-url> && cd sofa-agent-wallet
npm install
cd frontend && npm install && cd ..
```

### 2. Start infrastructure

```bash
docker compose up -d
```

This starts PostgreSQL (port 5432) and Redis (port 6379).

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env with your Openfort, database, and app settings
```

Required variables:

| Variable | Description |
|----------|-------------|
| `OPENFORT_API_KEY` | Openfort API secret key |
| `OPENFORT_PUBLISHABLE_KEY` | Openfort publishable key used by the backend RPC / bundler client |
| `OPENFORT_WALLET_SECRET` | Openfort wallet signing secret; never expose or log it |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `DEFAULT_CHAIN_ID` | Default chain (84532 for Base Sepolia) |
| `VITE_OPENFORT_PUBLISHABLE_KEY` | Openfort frontend publishable key (`frontend/.env`) |
| `VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY` | Openfort Shield frontend publishable key (`frontend/.env`) |
| `VITE_API_URL` | Backend URL for production (leave empty in dev — Vite proxy handles it) |
| `CORS_ORIGIN` | Allowed frontend origin(s) for CORS, comma-separated; required in production |

### 4. Run database migrations

```bash
npm run prisma:migrate:dev
```

### 5. Start development servers

```bash
# Backend (PORT from .env, 3100 by default in .env.example)
npm run start:dev

# Frontend (port 3000, in a separate terminal)
cd frontend && npm run dev
```

## Scripts

### Backend

| Command | Description |
|---------|-------------|
| `npm run start:dev` | Start backend in watch mode |
| `npm run build` | Compile backend |
| `npm run start:prod` | Run compiled backend |
| `npm run test` | Run unit tests |
| `npm run test:e2e` | Run end-to-end tests |
| `npm run test:cov` | Run tests with coverage |
| `npm run lint` | Lint and auto-fix |
| `npm run format` | Format with Prettier |
| `npm run prisma:generate` | Regenerate Prisma client |
| `npm run prisma:migrate:dev` | Create / apply migrations |
| `npm run prisma:studio` | Open Prisma Studio GUI |

### Frontend (`cd frontend`)

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server (port 3000, proxies `/api` to backend) |
| `npm run build` | Production build → `dist/` (static files, deployable to S3) |
| `npm run preview` | Preview production build locally |

## API Overview

Public wallet signing and transaction endpoints require the `X-API-Key` header:

```
X-API-Key: sk_<64-hex-chars>
```

`POST /v1/wallets/sign` returns a Calibur wrapped signature for the user's
EIP-7702 delegated EOA. It is ABI-encoded as
`(bytes32 keyHash, bytes signature, bytes hookData)` and is intended for
Calibur/ERC-1271-style verification against `walletAddress`; it is not a plain
65-byte EOA signature recoverable directly with `ecrecover(walletAddress)`.

### Quick example — send USDC on Base Sepolia

```bash
curl -X POST http://localhost:3100/v1/transactions/send \
  -H "X-API-Key: sk_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "chainId": 84532,
    "idempotencyKey": "order-abc-123",
    "interactions": [{
      "to": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "data": "0xa9059cbb0000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000000f4240",
      "value": "0"
    }]
  }'
```

The `data` field is ABI-encoded calldata (`transfer(address,uint256)` in the example above). `value` is wei as a decimal string and defaults to `"0"` if omitted.

Query the returned transaction status without exposing calldata or request hashes:

```bash
curl http://localhost:3100/v1/transactions/<transactionId> \
  -H "X-API-Key: sk_your_key_here"
```

### Core Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/auth/session` | Openfort IAM | Sync Openfort session → returns `userId` and wallet state |
| `POST` | `/auth/embedded-wallet/authorize` | Openfort IAM | Bind an Openfort embedded EOA and return agent-key registration details |
| `POST` | `/auth/embedded-wallet/registration-transaction` | Openfort IAM | Save a submitted Calibur `registerKey` transaction hash |
| `POST` | `/auth/embedded-wallet/registration-result` | Openfort IAM | Mark agent-key registration as registered or failed |
| `GET` | `/auth/me` | Openfort IAM | Return current wallet and authorization state |
| `POST` | `/auth/refresh-api-key` | Openfort IAM | Revoke all active API keys and create a replacement |
| `POST` | `/v1/transactions/send` | API Key | Submit raw transaction (ABI-encoded calldata) |
| `GET` | `/v1/transactions/:id` | API Key | Query safe transaction status for the API-key user |
| `POST` | `/v1/wallets/sign` | API Key | Sign a message or typed data without broadcasting |
| `GET`  | `/v1/wallets/balances` | Openfort IAM + Frontend | Native token + USDC balances for the requested chain |
| `POST` | `/v1/wallets/deposit-info` | Openfort IAM + Frontend | Get wallet address for deposits |
| `POST` | `/v1/wallets/withdraw` | Openfort IAM + Frontend | Withdraw USDC to an external address |
| `GET/POST/DELETE` | `/v1/api-keys/*` | Openfort IAM + Frontend | API key management (list, create, revoke) |

> **Access control split**: `POST /v1/wallets/sign`, `POST /v1/transactions/send`, and `GET /v1/transactions/:id` are API-key-only public endpoints. All other `/v1/*` routes are frontend-only and additionally require an Openfort IAM bearer token plus a matching `Origin`/`Referer` header.
>
> API keys cannot manage API keys. `/v1/api-keys/*` is Openfort-dashboard-only, requires unique non-empty key names, enforces a maximum of 10 active keys per user, validates expiry/IP allowlists, and returns raw secrets only once on creation/rotation.

### Public API error contract

Errors use a stable machine-readable `code` plus a human-readable `message`:

```json
{
  "statusCode": 401,
  "code": "INVALID_API_KEY",
  "message": "Invalid API key",
  "requestId": "req_...",
  "timestamp": "2026-04-20T10:00:00.000Z",
  "path": "/v1/transactions/send"
}
```

Validation errors use `code: "VALIDATION_ERROR"` and include `details` with field-level messages. Common public API codes include `API_KEY_REQUIRED`, `INVALID_API_KEY`, `IP_NOT_ALLOWED`, `CHAIN_NOT_SUPPORTED`, `IDEMPOTENCY_CONFLICT`, `WALLET_NOT_FOUND`, and `TRANSACTION_NOT_FOUND`.

Full OpenAPI spec (public endpoints only): [`openapi.yaml`](./openapi.yaml)

## Project Structure

```
sofa-agent-wallet/
├── src/
│   ├── main.ts                  # NestJS bootstrap
│   ├── app.module.ts            # Root module
│   ├── common/                  # Guards, filters, decorators
│   ├── config/                  # Environment config
│   ├── core/                    # Prisma, Openfort providers
│   └── modules/
│       ├── auth/                # Openfort IAM session + embedded EOA authorization
│       ├── wallet/              # Openfort wallet operations
│       ├── transactions/        # Calibur agent UserOperation submission
│       └── api-key/             # Key generation, validation, rotation
├── prisma/
│   └── schema.prisma            # Database schema (4 models)
├── frontend/                    # Vite + React SPA (static, deployable to S3/CloudFront)
├── test/                        # E2E tests
├── docker-compose.yml           # PostgreSQL + Redis
├── openapi.yaml                 # API specification (public endpoints only)
└── DESIGN.md                    # Full design document
```

## Data Models

Core tables managed by Prisma:

- **users** — Openfort IAM user mapping and email
- **user_wallets** — 1:1 with user; stores embedded EOA details and backend agent signer metadata
- **api_keys** — Argon2-hashed keys; `keyPrefix` (27 chars for new keys, legacy 11 chars supported) used for lookup before full hash verification; optional IP/expiry allowlists; active key names are unique per user
- **api_key_events** — immutable audit events for key creation, revocation, and rotation with key prefix/name snapshots
- **wallet_chain_authorizations** — per-chain Calibur agent-key registration status, transaction hash, and expiry
- **transactions** — transaction/user operation status, tx hash, chain ID, wallet address, request hash, and API-key attribution snapshot

## Development Phases

| Phase | Scope | Status |
|-------|-------|--------|
| **1 — MVP** | Auth + wallet creation + API key middleware + basic transfer/withdraw | In progress |
| **2** | Calibur delegation, UserOperation batching, webhooks | Planned |
| **3** | Monitoring, rate limiting, multi-chain, frontend demo | Planned |

## Testing

- **Testnet**: Base Sepolia (chain ID `84532`)
- **USDC Faucet**: [Circle USDC Faucet](https://faucet.circle.com/)
- **Load target**: 1,000 concurrent transaction intents

```bash
npm run test          # Unit tests
npm run test:e2e      # E2E tests (requires docker compose up -d)
npm run test:cov      # Coverage report
```

## Deployment

The frontend is a **pure static SPA** — `npm run build` in `frontend/` produces a `dist/` folder that can be served from any static host:

| Host | Notes |
|------|-------|
| **S3 + CloudFront** | Upload `dist/` to S3, set `VITE_API_URL` at build time, configure CloudFront to redirect 404s to `index.html` for SPA routing |
| **Vercel / Netlify** | Zero-config; add `_redirects` or `vercel.json` for SPA fallback |
| **Nginx** | `try_files $uri /index.html;` |

Set `CORS_ORIGIN` on the NestJS backend to match the frontend's domain.

## License

UNLICENSED — Private project.
