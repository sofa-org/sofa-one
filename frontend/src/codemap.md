# SOFA ONE Frontend Application (`frontend/src/`)

> Parent codemap for the React application layer. It aggregates the sub-maps
> below and the direct code in this directory; for per-module detail read the
> child maps first:
> - `components/codemap.md` — shared/auth providers, route guards, step-up gate, error/config/UI components
> - `lib/codemap.md` — `api.ts` (typed HTTP client), `calibur.ts` (smart-account helpers), `chains.ts` (chain metadata)
> - `pages/codemap.md` — public landing + sign-in pages
> - `pages/dashboard/codemap.md` — authenticated dashboard screens

## Responsibility
The entire SPA (Vite 6 + React 19 + React Router 7 + Tailwind CSS 4 + Openfort).
It is the browser-side half of SOFA ONE's server-side-signing model: the app
signs users in with Openfort IAM (email OTP), provisions an Openfort TEE-managed
EOA and a Calibur smart-account agent key, and manages backend API keys,
withdrawals, transactions, notifications, and billing. The app never touches
private keys — it only holds the user's recovery password (browser-local) and
signs through the Openfort embedded wallet.

Top-level responsibilities in this directory:
- `main.tsx` — app entry: `StrictMode` → `ErrorBoundary` → `BrowserRouter` → `App`.
- `App.tsx` — route tree and lazy module graph; the `/dashboard` route composes
  the full auth/provider/guard chain.
- `index.css` — Tailwind 4 entry with the brand `@theme` tokens (colors, fonts).
- `types/` — currently empty; all DTOs live in `lib/api.ts` co-located with their
  wrapper functions.

## Directory Map
| Path | Role |
| --- | --- |
| `components/` | Reusable/shared components: provider stacks (`AuthProviders`, `OpenfortAuthProvider`), route guards (`ProtectedRoute`, `PublicOnlyRoute`), MFA step-up gate (`DashboardStepUpGate`), `ErrorBoundary`, `OpenfortConfigError`, `CopyButton`, `AuthFormPanel`. No business logic; composes `@openfort/react`, Router, and `lib/api`. |
| `lib/` | Browser-side helper layer: `api.ts` (two typed fetch transports `authFetch`/`apiFetch`, per-route wrappers, `ApiError` normalization, `DEFAULT_CHAIN_ID`), `calibur.ts` (Calibur key hashing/settings/calldata encoders + EIP-7702 EntryPoint v0.8 smart-account factory), `chains.ts` (14-chain static registry + explorer/faucet helpers). |
| `pages/` | Public routes: `Landing.tsx`, `SignIn.tsx` (split-layout auth shell that lazy-loads `AuthFormPanel`), `EmailOtpForm.tsx`. |
| `pages/dashboard/` | All authenticated screens under `/dashboard/*` plus the `DashboardLayout` shell, wallet-setup sub-forms, presentational helpers, step-up helpers (`step-up.ts`, `step-up-session.ts`), and the `notification-events.ts` window-event bus. |
| `types/` | Empty (unused; request/response types are exported from `lib/api.ts`). |
| `main.tsx`, `App.tsx`, `index.css` | Entry, routing/provider composition, global styling. |

## Design/Patterns
- **Provider composition, two distinct stacks**:
  - Global shell (`main.tsx`): `StrictMode` → `ErrorBoundary` → `BrowserRouter` → `App`. No Openfort context at the root.
  - Dashboard stack (`components/AuthProviders`, lazy in `App.tsx`): `QueryClientProvider` (module-level `QueryClient`) → `WagmiProvider` (module-level `wagmiConfig` built once via `getDefaultConfig` with 13 viem chains, `http()` transports, `VITE_*_RPC_URL` overrides) → `OpenfortWagmiBridge` → `OpenfortProvider` (EVM chain, EOA account on `DEFAULT_CHAIN_ID` = 84532, `connectOnLogin: false`, Shield publishable key, `EMAIL_OTP` + PASSWORD recovery).
  - Public sign-in stack (`components/OpenfortAuthProvider`): bare `OpenfortProvider` with `EMAIL_OTP` only (no Wagmi/Shield), composed by `AuthFormPanel` → `PublicOnlyRoute` → `EmailOtpForm`.
- **Layered route guards** on `/dashboard`: `ProtectedRoute` (auth session check via `useOpenfort`, redirects to `/sign-in` with `state.from` for return navigation) → `DashboardStepUpGate` (TOTP MFA state machine `checking|setup|verify|recovery|ready|error`, provisions TOTP on first use, proof cached in `sessionStorage` via `step-up-session.ts`) → `DashboardLayout` (sidebar + `<Outlet />`). `PublicOnlyRoute` keeps signed-in users off `/sign-in`.
- **Lazy loading everywhere**: every route target and guard is `react.lazy()`; Vite splits `vendor` (react/react-dom/router) and `wallet` (`@openfort/*`, `wagmi`, `viem`) chunks manually.
- **No global store**: each dashboard page owns fetch/loading/error state; `useCallback` loaders + `useEffect` with `AbortController`; retry via nonce bump. Stale-response guards via request-id refs and `isMountedRef`.
- **Token accessor pattern**: pages build `getToken = useCallback(async () => getAccessToken()...)` from `useUser()` and pass it to `lib/api` helpers; never stored in `lib/api`.
- **Step-up gating for sensitive mutations**: guarded calls (`withdraw`, allowlist changes, API-key create/revoke/rotate) use `getDashboardStepUpToken() ?? await requestStepUpToken(getToken)`; the proof token is sent as `X-Step-Up-Token` and cleared on sign-out.
- **Access-control split respected on the client**: dashboard data goes through bearer-token `*Auth` wrappers only; the API-key transports (`apiFetch`, `*WithApiKey`) are used exclusively for the three public endpoints (sign/send/status) shown in `Docs.tsx`.
- **Cross-page sync via window events**: `notification-events.ts` notifies `DashboardLayout`'s unread badge when alerts change.
- **Local persistence**: chain selection (`sofa-one.wallet.balanceChainId`, `sofa-one.wallet.agentChainId`) and API-key status filter in `localStorage`; step-up proof in `sessionStorage`.

## Flow
1. **Boot**: `main.tsx` renders `ErrorBoundary` → `BrowserRouter` → `App`; `App` shows a `Suspense` fallback while lazy chunks load.
2. **Public routes**: `/` → `LandingPage`; `/sign-in/*` → `SignInPage` → `AuthFormPanel` (`OpenfortAuthProvider` validates `VITE_OPENFORT_PUBLISHABLE_KEY`, renders `OpenfortConfigError` if missing; `PublicOnlyRoute` bounces authenticated users to `/dashboard`). `/sign-up/*` → redirect to `/sign-in`; `*` → `/`.
3. **Dashboard**: `/dashboard` mounts `AuthProviders → ProtectedRoute → DashboardStepUpGate → DashboardLayout` with index (`WalletPage`) and child routes `api-keys`, `transactions`, `notifications`, `billing`, `docs`. `DashboardStepUpGate` runs `syncSession` → `getMfaStatusAuth` and holds the tree until a valid TOTP proof exists (setup QR or verify form).
4. **Data flow**: pages fetch `getToken` from Openfort `useUser`, then call `lib/api` `*Auth` helpers (bearer token) against the backend via `VITE_API_URL` or the `/api` Vite proxy. Wallet setup additionally uses `lib/calibur` encoders + viem/wagmi to build and submit a Calibur registration UserOp through Openfort/Pimlico. Mutations that need MFA go through the step-up proof flow (client sessionStorage → `X-Step-Up-Token` header → backend validation).
5. **Billing**: Stripe card checkout redirects to `checkoutUrl` and returns via `?success`/`?canceled` search params; USDC payment runs inline in `UsdcPaymentPanel` (quote → claim → silent invoice refresh).

## Integration
- **Backend**: all dashboard traffic is HTTP to the NestJS API through `lib/api` (`API_BASE = VITE_API_URL || '/api'`; throws in production if unset). Vite dev proxy forwards `/api` → `http://localhost:3100` (or `VITE_API_PROXY_TARGET`) and strips the prefix. Public API examples are the only client-side API-key calls; private keys never transit this code.
- **Openfort**: `@openfort/react` providers/`useOpenfort`/`useUser` for IAM auth and embedded EOA; `@openfort/react/wagmi` for the wagmi bridge and config; `@openfort/react/ethereum` for the embedded wallet (manualChunks `wallet`).
- **Wallet/chain stack**: `wagmi` + `viem` (public clients, bundler/paymaster, `usePublicClient`, `use7702Authorization`); `lib/calibur` for Calibur registry calldata and EIP-7702 smart-account factory.
- **React Query**: `QueryClient` at the dashboard provider root (used by wagmi/Openfort internals).
- **Routing**: React Router 7 declarative routes in `App.tsx`; `state.from` round-trip between `ProtectedRoute` and `PublicOnlyRoute`; `DashboardLayout` provides the nested `<Outlet />`.
- **Styling**: Tailwind 4 via `@tailwindcss/vite`; brand tokens in `index.css` `@theme`; `@` alias resolves to `./src`.

## Runtime Configuration
- `VITE_OPENFORT_PUBLISHABLE_KEY` — required everywhere; missing → `OpenfortConfigError`.
- `VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY` — required for the dashboard provider (wallet recovery); missing → `OpenfortConfigError`.
- `VITE_API_URL` — backend base URL; unset → `/api` Vite proxy. Must be set in production builds (`api.ts` throws at module load otherwise).
- `VITE_API_PROXY_TARGET` — dev-only proxy target (default `http://localhost:3100`).
- `VITE_*_RPC_URL` (per chain, e.g. `VITE_BASE_SEPOLIA_RPC_URL`) — optional public-RPC overrides in the wagmi config.
- `VITE_OPENFORT_FEE_SPONSORSHIP_ID` — optional; skips native-gas check during agent registration when set.
- `VITE_PIMLICO_API_KEY`, `VITE_PIMLICO_RPC_URL_<chainId>` — bundler config for Calibur UserOp submission (Monad uses Pimlico).
- `DEFAULT_CHAIN_ID` — hardcoded 84532 (Base Sepolia), exported from `lib/api`, used by `OpenfortProvider` account config and chain defaulting.

## Security boundaries
- Private keys never leave Openfort; the frontend holds only the recovery password and proof tokens.
- Raw API keys are displayed once (amber banner, 2-minute TTL), never persisted, and only ever used to demo the three public endpoints.
- Guarded mutations require a session-scoped TOTP step-up proof (expiry-checked, cleared on sign-out).
- Backend enforces the access-control split; the client never calls API-key-protected dashboard routes and never sends bearer tokens to public API-key endpoints.
- Withdrawal recipients are validated `^0x[a-fA-F0-9]{40}$`; public status responses shown in Docs omit calldata/request hashes.
