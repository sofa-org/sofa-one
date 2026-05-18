# Deployment

## 1. Runtime components

- NestJS backend from repository root.
- Static Vite/React frontend from `frontend/dist`.
- PostgreSQL 16.
- Redis 7 is present for planned queue/cache work; do not assume queue behavior unless implemented.
- Openfort account/API credentials.

## 2. Backend environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `OPENFORT_API_KEY` | Yes | Openfort backend secret; never expose to browser |
| `OPENFORT_WALLET_SECRET` | Yes | TEE wallet signing secret; never log |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `OPENFORT_PUBLISHABLE_KEY` | No | Used by backend RPC/bundler integrations when needed |
| `OPENFORT_TIMEOUT_MS` | No | SDK timeout; max validated value is `120000` |
| `REDIS_URL` | No | Redis connection string for future queue/cache use |
| `DEFAULT_CHAIN_ID` | No | Defaults to `84532`; must be supported |
| `PORT` | No | Code default `3001`; `.env.example` uses `3100` |
| `NODE_ENV` | No | `development`, `production`, or `test` |
| `CORS_ORIGIN` | Production yes | Comma-separated allowed frontend origins |
| `TRUST_PROXY` | Production yes | Explicit trusted proxy IP/CIDR values; not `true`/`1` |

## 3. Frontend environment variables

Browser-safe only:

| Variable | Notes |
| --- | --- |
| `VITE_OPENFORT_PUBLISHABLE_KEY` | Openfort frontend publishable key |
| `VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY` | Openfort Shield publishable key |
| `VITE_OPENFORT_FEE_SPONSORSHIP_ID` | Optional sponsorship policy |
| `VITE_API_URL` | Backend URL in deployed environments; leave unset in local dev to use Vite proxy |
| `VITE_*_RPC_URL` | Optional public RPC overrides |

Never place backend secrets in `VITE_*` variables.

## 4. Local infrastructure

`docker-compose.yml` starts PostgreSQL and Redis bound to localhost ports:

- PostgreSQL: `127.0.0.1:5432`
- Redis: `127.0.0.1:6379`

The compose network is marked internal. Use host port bindings for local app access.

## 5. Build commands

Backend:

```bash
npm install
npm run prisma:generate
npm run build
npm run start:prod
```

Frontend:

```bash
cd frontend
npm install
npm run build
```

## 6. Production checklist

- Set `NODE_ENV=production`.
- Set non-empty `CORS_ORIGIN` to exact frontend origin(s).
- Set `TRUST_PROXY` to trusted proxy IP/CIDR values.
- Use strong PostgreSQL/Redis credentials.
- Run `npm run prisma:migrate:deploy` before starting new backend code.
- Confirm `OPENFORT_API_KEY` and `OPENFORT_WALLET_SECRET` are present only in backend secret storage.
- Build frontend with the intended `VITE_API_URL`.
- Ensure SPA hosting falls back to `index.html` for client-side routing.
- Confirm logs redact authorization headers, raw API keys, and Openfort secrets.

## 7. Static frontend hosting

The frontend is a static SPA. Common hosting options:

- S3 + CloudFront: upload `frontend/dist`, configure SPA fallback.
- Vercel/Netlify: configure fallback/redirects for React Router.
- Nginx: use `try_files $uri /index.html;`.

Backend CORS must allow the deployed frontend origin.
