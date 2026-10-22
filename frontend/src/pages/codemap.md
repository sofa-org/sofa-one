# Pages (`frontend/src/pages/`)

## Responsibility
Top-level route components for the SOFA ONE SPA. This directory owns the **public pages and auth entry points** (`Landing`, `SignIn`, `EmailOtpForm`) and is the **parent container for the authenticated `dashboard/` subtree**. Public pages are presentational and drive users into the Openfort email-OTP sign-in flow; the dashboard subtree (documented in its own `dashboard/codemap.md`) holds all authenticated, post-sign-in screens. No backend/API business logic lives at this level — pages compose React Router, `@openfort/react`, and shared components.

## Directory Map
- `Landing.tsx` — `/` landing page; product pitch, public navigation, onboarding steps, feature chips, CTAs to `/sign-in` and `/dashboard/docs`.
- `Protocols.tsx` — unauthenticated `/protocols` directory with search, official-site links and a direct download of `/protocols.json`, whose chain entries separate `contracts` and `sign`; `supported-protocols.ts` keeps its canonical display dataset separate from the backend registry. The download is generated catalog metadata, not API-key grants, live execution guarantees or a bypass of runtime nested-execution or signing domain/wallet/payload validation.
  - The directory includes ApeSwap, BabySwap, Biswap, Dfyn, Resolv, ShibaSwap and WOOFi alongside the existing canonical SushiSwap/Uniswap/Frax entries; versions do not create duplicate product cards. KyberSwap remains excluded.
  - BabySwap links to archived official deployment documentation because its former live site serves a lander; Dfyn links to official contract documentation (direct availability could not be confirmed). The directory is informational, not an assurance of live website or protocol availability. Cards allow shrinking so long reference URLs truncate without mobile overflow.
  - BakerySwap links to its official source repository because the former live domain serves a lander; it represents the reviewed direct BSC router, not an assertion that the old frontend remains operational.
  - Alchemix represents only the reviewed Ethereum V3 Alchemist; frozen V2 calls remain unadmitted. Alpaca remains absent because its reported implementation ABI/source could not be bound.
  - THENA represents the BSC classic Router V2's explicit swaps/liquidity, not its aggregator or separate Algebra router. Synapse is absent pending an approved nested adapter/pool execution scope.
  - MDEX represents the reviewed BSC `new_router`, not its old router or HECO deployments. Pickle Finance represents the exact pCurve 3pool jar, not all jars, gauges or strategies.
  - JetSwap and WaultSwap represent only the exact reviewed BSC direct routers' ordinary swap/liquidity functions. JetSwap links to archived official deployment documentation because its former domain serves unrelated casino content; WaultSwap links to its attributable source repository, not an assertion that the legacy frontend operates. Neither card admits permits or claims current liquidity.
  - Dystopia represents the exact Polygon direct router's seven explicit swaps and five non-permit liquidity actions; its card links to official deployment documentation. KnightSwap represents the exact BSC direct router's ordinary swaps/liquidity and links to deployment docs.
  - Disbanded, winding-down/shut-down protocols and retired/sunset or explicitly unmaintained deployments are excluded without an exit-only exception. Nomiswap, Mountain Protocol, Saddle, mStable, Prisma Finance, Badger legacy Sett, Nerve Finance and Ramses V1 have no cards or runtime/public catalog capabilities. Historical evidence does not grant support or justify re-admission.
- `Pricing.tsx` — public `/pricing` page with links to the protocol directory and sign-in.
- `SignIn.tsx` — `/sign-in/*` auth shell; responsive split layout (brand panel + form panel) that lazy-loads `AuthFormPanel`.
- `EmailOtpForm.tsx` — Openfort email OTP followed by explicit SOFA session exchange before redirect; walletReauthentication mode reconnects provider identity without replacing the SOFA session.
- `dashboard/` — authenticated dashboard subtree (see `dashboard/codemap.md`): `DashboardLayout`, `Wallet`, `ApiKeys`, `Transactions`, `SecurityNotifications`, `Billing`, `Docs`, plus setup/step-up/helper modules. Not detailed here; see the child map.
- `codemap.md` — this file.

## Design/Patterns
- **Presentational public pages**: `Landing` and `SignIn` are static, copy-driven components using Tailwind brand tokens (`brand-*`) and `react-router-dom` `<Link>`s; no data fetching.
- **Lazy route loading**: every page (public and dashboard) is `lazy()`-imported in `App.tsx` under a top-level `<Suspense>`; `SignIn` additionally lazy-loads `AuthFormPanel` with its own skeleton fallback.
- **Composition-root auth form**: PublicOnlyRoute uses SOFA state before mounting OpenfortAuthProvider → EmailOtpForm.
- **Controlled OTP form with local state**: `EmailOtpForm` holds `email`/`otp`/`sent`/`error`/`resendCooldownSeconds` locally; OTP input is normalized (strips spaces/dashes), auto-focuses on send, and enforces a 30s resend cooldown.
- **Redirect-state round-trip**: `ProtectedRoute` stores `state.from` on redirect to `/sign-in`; `EmailOtpForm` reads `location.state.from` and returns the user to the original dashboard path (preserving search/hash) after a successful sign-in, defaulting to `/dashboard`.

## Flow

### Routing (`App.tsx`)
- `/` → `LandingPage` (public navigation links to `/protocols` and `/pricing`)
- `/protocols` → lazy-loaded public protocol directory; no auth provider or route guard
- `/pricing` → `PricingPage`
- `/sign-in/*` → `SignInPage` (renders `AuthFormPanel` → `EmailOtpForm`)
- `/sign-up/*` → `<Navigate to="/sign-in" replace />`
- `/dashboard` → ProtectedRoute → DashboardStepUpGate → DashboardLayout under AppSessionProvider; only index WalletPage mounts AuthProviders.
- `*` → `<Navigate to="/" replace />`
- All routes wrapped in `ErrorBoundary` (from `src/main.tsx`) and a top-level `<Suspense>` with `PageFallback`.

### Public → auth → dashboard boundary
1. Unauthenticated user hits `/dashboard` → `ProtectedRoute` redirects to `/sign-in` with `state.from`.
2. PublicOnlyRoute restores SOFA state, then AuthFormPanel mounts the minimal Openfort provider for anonymous sign-in.
3. EmailOtpForm requests/verifies OTP, obtains a provider token and awaits local session exchange before returning to the original dashboard path.
4. Authenticated user re-visits `/sign-in` → `PublicOnlyRoute` redirects back to `/dashboard`.

### Dashboard subtree boundary
DashboardLayout renders Outlet; all non-wallet pages call cookie/CSRF API helpers without Openfort hooks. DashboardStepUpGate requires server-confirmed MFA before the layout mounts; sensitive mutations retain exact-session step-up.

## Integration
- **Routing**: `App.tsx` lazy-imports `Landing`, `SignIn`, and all dashboard pages; `SignIn` lazy-imports `AuthFormPanel` from `src/components/`.
- **Auth**: useEmailOtpAuth/useUser are confined to explicit sign-in or wallet identity work; AppSessionProvider supplies route/dashboard authentication.
- **Shared components**: `AuthFormPanel`, `ProtectedRoute`, `PublicOnlyRoute`, `AuthProviders`, `DashboardStepUpGate`, `ErrorBoundary` (all in `src/components/`).
- **API layer**: pages themselves make no direct API calls; the dashboard subtree consumes `@/lib/api` `*Auth` helpers, and `DEFAULT_CHAIN_ID` is sourced from `src/lib/api` by `AuthProviders`.
- **Env**: Openfort publishable key is required for sign-in; Shield is required only for wallet controls, not non-wallet dashboard access.
- **Cross-cutting**: `EmailOtpForm` is the single shared auth form, referenced by `AuthFormPanel` and documented in `src/components/codemap.md`; the dashboard subtree's `step-up-session.ts` and `notification-events.ts` are consumed by `src/components/` guards.

## Security notes
- Public pages never touch private keys or API keys; they only drive the Openfort email-OTP flow.
- `PublicOnlyRoute` prevents authenticated users from re-entering the sign-in flow.
- The dashboard subtree (see its codemap) enforces TOTP step-up for guarded mutations and never persists raw API keys.
