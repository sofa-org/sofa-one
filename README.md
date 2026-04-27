# SOFA ONE

Server-side automated blockchain signing for users authenticated via social OAuth. Users receive a Backend Wallet (managed in TEE via [Openfort](https://www.openfort.io/)) and an API Key for programmatic transaction submission.

## Architecture

```
[User Client]
   ↓ Social OAuth (Google, Twitter/X, Discord, Apple)
[Frontend — Vite + React SPA + Clerk]
   ↓ HTTPS + JWT
[Backend — NestJS]
   ├── Auth Module        (Clerk social login + user provisioning)
   ├── Wallet Module      (Openfort SDK — backend wallet lifecycle)
   ├── Transaction Module (raw transaction submission + signing)
   └── API Key Module     (generation, validation, rotation, revocation)
   ↓
[Openfort SDK → TEE]     [PostgreSQL + Redis]     [EVM Chains]
  Private key custody      User/wallet/key store    Base · Ethereum
```

### Key Properties

- **Private keys never leave the TEE** — all signing happens inside Openfort / AWS Nitro Enclaves.
- **Dual auth** — every wallet operation requires both a platform JWT _and_ a user `X-API-Key` header.
- **API keys hashed with Argon2** — never stored in plaintext; the first 11 characters (`keyPrefix`) are stored for fast DB lookup before hash comparison.
- **Gas paid in USDC** — via Openfort `charge_custom_tokens` policy; users don't need native tokens.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vite 6, React 19, React Router 7, Tailwind CSS 4, Clerk |
| Backend | NestJS 10, TypeScript 5 |
| Wallet Core | Openfort Node SDK |
| Database | PostgreSQL 16, Prisma 5 |
| Cache / Queue | Redis 7, BullMQ (Phase 2) |
| Chains | Base (8453), Ethereum (1), Base Sepolia (84532), Ethereum Sepolia (11155111), Polygon (137), Polygon Amoy (80002) |

## Prerequisites

- **Node.js** ≥ 20
- **Docker** (for PostgreSQL + Redis)
- **Clerk** account — [clerk.com](https://clerk.com)
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
# Edit .env with your Clerk and Openfort keys
```

Required variables:

| Variable | Description |
|----------|-------------|
| `CLERK_SECRET_KEY` | Clerk backend secret key |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk frontend publishable key (Vite-prefixed) |
| `OPENFORT_API_KEY` | Openfort API secret key |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `DEFAULT_CHAIN_ID` | Default chain (84532 for Base Sepolia) |
| `VITE_API_URL` | Backend URL for production (leave empty in dev — Vite proxy handles it) |
| `CORS_ORIGIN` | Allowed frontend origin(s) for CORS, comma-separated (defaults to `*`) |

### 4. Run database migrations

```bash
npm run prisma:migrate:dev
```

### 5. Start development servers

```bash
# Backend (port 3001)
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

All wallet and transaction endpoints require the `X-API-Key` header:

```
X-API-Key: sk_<64-hex-chars>
```

### Quick example — send USDC on Base Sepolia

```bash
curl -X POST http://localhost:3001/v1/transactions/send \
  -H "X-API-Key: sk_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "chainId": 84532,
    "interactions": [{
      "to": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "data": "0xa9059cbb000000000000000000000000<recipient>0000000000000000000000000000000000000000000000000000000000000f4240",
      "value": "0"
    }]
  }'
```

The `data` field is ABI-encoded calldata (`transfer(address,uint256)` in the example above). `value` is wei as a decimal string and defaults to `"0"` if omitted.

### Core Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/auth/social` | Public | Social login → returns `userId`, `walletAddress`, `apiKey` |
| `POST` | `/auth/refresh-api-key` | JWT | Rotate API key |
| `POST` | `/v1/transactions/send` | API Key | Submit raw transaction (ABI-encoded calldata) |
| `POST` | `/v1/wallets/sign` | API Key | Sign a message or typed data without broadcasting |
| `GET`  | `/v1/wallets/balances` | JWT + Frontend | ETH + USDC balances across **all** supported chains simultaneously |
| `POST` | `/v1/wallets/deposit-info` | JWT + Frontend | Get wallet address for deposits |
| `POST` | `/v1/wallets/withdraw` | JWT + Frontend | Withdraw USDC to an external address |
| `GET/POST` | `/v1/api-keys/*` | JWT + Frontend | API key management (list, create, revoke) |

> **Access control split**: `POST /v1/transactions/send` and `POST /v1/wallets/sign` are public API endpoints — an `X-API-Key` alone is sufficient. All other `/v1/*` routes are frontend-only and additionally require a Clerk JWT plus a matching `Origin`/`Referer` header.

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
│       ├── auth/                # Clerk social OAuth
│       ├── wallet/              # Openfort wallet operations
│       ├── transaction/         # Raw transaction submission & signing
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

Four core tables managed by Prisma:

- **users** — social provider, social ID, email
- **user_wallets** — 1:1 with user; stores Openfort account ID + on-chain address
- **api_keys** — Argon2-hashed keys; `keyPrefix` (first 11 chars) used for fast DB lookup; optional IP/expiry allowlists
- **transactions** — Openfort intent ID, tx hash, status, chain ID, wallet address

## Development Phases

| Phase | Scope | Status |
|-------|-------|--------|
| **1 — MVP** | Auth + wallet creation + API key middleware + basic transfer/withdraw | In progress |
| **2** | EIP-7702 delegation, USDC gas policy, batch transactions, webhooks | Planned |
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
