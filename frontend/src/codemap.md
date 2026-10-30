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
| `pages/` | Public routes: `Landing.tsx`, `Protocols.tsx` (directory backed by `supported-protocols.ts`), `Pricing.tsx`, `SignIn.tsx` (split-layout auth shell that lazy-loads `AuthFormPanel`), `EmailOtpForm.tsx`. |
| `pages/dashboard/` | All authenticated screens under `/dashboard/*` plus the `DashboardLayout` shell, wallet-setup sub-forms, presentational helpers, step-up helpers (`step-up.ts`, `step-up-session.ts`), and the `notification-events.ts` window-event bus. |
| `types/` | Empty (unused; request/response types are exported from `lib/api.ts`). |
| `main.tsx`, `App.tsx`, `index.css` | Entry, routing/provider composition, global styling. |

## Design/Patterns
- **Provider composition, two distinct stacks**:
  - Global shell (`main.tsx`): `StrictMode` → `ErrorBoundary` → `BrowserRouter` → `App`. No Openfort context at the root.
  - Wallet-only stack: AuthProviders mounts QueryClient/Wagmi/Openfort/Shield around the wallet index; missing wallet configuration does not block non-wallet pages.
  - Sign-in stack: PublicOnlyRoute checks SOFA state, then mounts OpenfortAuthProvider → EmailOtpForm for explicit identity exchange.
- **Route guards**: AppSessionProvider restores a server snapshot; ProtectedRoute handles missing sessions/outages and keys content by session ID. DashboardStepUpGate requires server-confirmed MFA and retains recovery acknowledgement; cached proofs never grant access.
- **Lazy loading**: every route target and guard is `react.lazy()`; Rollup assigns shared chunks from the route graph (no manual SDK bucket that pulls shared JSX/preload runtime into the public entry).
- **No global store**: each dashboard page owns fetch/loading/error state; business effects depend on stable session ID, not each introspection snapshot. History list/detail requests are abort-guarded across filtering, pagination, refresh, tab changes and unmount. Ordinary session checks share one in-flight request; explicit exchange/revocation/expiry retain request-version isolation.
- **Cookie transport**: dashboard helpers no longer take token callbacks. They include credentials and unsafe-request CSRF; explicit bearer identity is confined to exchange and wallet authorization.
- **Step-up**: exact-session proof cache is expiry-checked and cleared on replacement/logout; delayed verification responses carry their originating session ID.
- **Audience split**: API-key examples retain explicit keys, never substituted for dashboard cookies.
- **Cross-page sync via window events**: `notification-events.ts` notifies `DashboardLayout`'s unread badge when alerts change.
- **Local persistence**: chain selection (`sofa-one.wallet.balanceChainId`, `sofa-one.wallet.agentChainId`) and API-key status filter in `localStorage`; step-up proof in `sessionStorage`.

## Flow
1. **Boot**: `main.tsx` renders `ErrorBoundary` → `BrowserRouter` → `App`; `App` shows a `Suspense` fallback while lazy chunks load.
2. **Public routes**: `/` → `LandingPage`; `/protocols` → lazy-loaded, unauthenticated `ProtocolsPage`; `/pricing` → `PricingPage`; `/sign-in/*` → `SignInPage` → `AuthFormPanel` (`OpenfortAuthProvider` validates `VITE_OPENFORT_PUBLISHABLE_KEY`, renders `OpenfortConfigError` if missing; `PublicOnlyRoute` bounces authenticated users to `/dashboard`). `/sign-up/*` → redirect to `/sign-in`; `*` → `/`.
3. **Dashboard**: ProtectedRoute → DashboardStepUpGate → DashboardLayout. Server pending-MFA sessions set up/verify TOTP before entry; only Wallet mounts heavy wallet providers.
   DashboardLayout contains its Outlet in a pathname-keyed inline ErrorBoundary and Suspense. Child chunks can suspend or fail without hiding navigation or sign-out; changing route resets the child error.
4. **Data flow**: cookie/CSRF helpers serve dashboard reads/mutations. Wallet creation/authorization still uses provider proof, Calibur encoders and viem/wagmi; reconnecting provider identity does not exchange the application session.
5. **Billing**: Stripe card checkout redirects to `checkoutUrl` and returns via `?success`/`?canceled` search params; USDC payment runs inline in `UsdcPaymentPanel` (quote → pay-from-wallet with step-up / status poll, or manual claim → silent invoice refresh only when server reports paid).

## Integration
- **Backend**: all dashboard traffic is HTTP to the NestJS API through `lib/api` (`API_BASE = VITE_API_URL || '/api'`; throws in production if unset). Vite dev proxy forwards `/api` → `http://localhost:3100` (or `VITE_API_PROXY_TARGET`) and strips the prefix. Public API examples are the only client-side API-key calls; private keys never transit this code.
- **Openfort**: `@openfort/react` providers/`useOpenfort`/`useUser` for IAM auth and embedded EOA; `@openfort/react/wagmi` for the wagmi bridge and config; `@openfort/react/ethereum` for the embedded wallet (manualChunks `wallet`).
- **Wallet/chain stack**: `wagmi` + `viem` (public clients, bundler/paymaster, `usePublicClient`, `use7702Authorization`); `lib/calibur` for Calibur registry calldata and EIP-7702 smart-account factory.
- **React Query**: QueryClient is wallet-provider-local for Wagmi/Openfort internals.
- **Routing**: React Router 7 declarative routes in `App.tsx`; `state.from` round-trip between `ProtectedRoute` and `PublicOnlyRoute`; `DashboardLayout` provides the nested `<Outlet />`.
- **Styling**: Tailwind 4 via `@tailwindcss/vite`; brand tokens in `index.css` `@theme`; `@` alias resolves to `./src`.

## Runtime Configuration
- VITE_OPENFORT_PUBLISHABLE_KEY is required for email sign-in and wallet controls, not local-session non-wallet pages.
- VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY is required only by the wallet provider/recovery path.
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
