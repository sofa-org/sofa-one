# Pages (`frontend/src/pages/`)

## Responsibility
Top-level route components for the SOFA ONE SPA. This directory owns the **public pages and auth entry points** (`Landing`, `SignIn`, `EmailOtpForm`) and is the **parent container for the authenticated `dashboard/` subtree**. Public pages are presentational and drive users into the Openfort email-OTP sign-in flow; the dashboard subtree (documented in its own `dashboard/codemap.md`) holds all authenticated, post-sign-in screens. No backend/API business logic lives at this level — pages compose React Router, `@openfort/react`, and shared components.

## Directory Map
- `Landing.tsx` — `/` landing page; product pitch, onboarding steps, feature chips, CTAs to `/sign-in` and `/dashboard/docs`.
- `SignIn.tsx` — `/sign-in/*` auth shell; responsive split layout (brand panel + form panel) that lazy-loads `AuthFormPanel`.
- `EmailOtpForm.tsx` — the actual Openfort email-OTP form (request code → verify code → redirect); rendered inside `AuthFormPanel`'s provider/guard stack.
- `dashboard/` — authenticated dashboard subtree (see `dashboard/codemap.md`): `DashboardLayout`, `Wallet`, `ApiKeys`, `Transactions`, `SecurityNotifications`, `Billing`, `Docs`, plus setup/step-up/helper modules. Not detailed here; see the child map.
- `codemap.md` — this file.

## Design/Patterns
- **Presentational public pages**: `Landing` and `SignIn` are static, copy-driven components using Tailwind brand tokens (`brand-*`) and `react-router-dom` `<Link>`s; no data fetching.
- **Lazy route loading**: every page (public and dashboard) is `lazy()`-imported in `App.tsx` under a top-level `<Suspense>`; `SignIn` additionally lazy-loads `AuthFormPanel` with its own skeleton fallback.
- **Composition-root auth form**: `SignIn` does not render the OTP form directly — it lazy-loads `AuthFormPanel` (from `src/components/`), which composes `OpenfortAuthProvider → PublicOnlyRoute → EmailOtpForm`. This keeps provider wiring and route guards out of the page layer.
- **Controlled OTP form with local state**: `EmailOtpForm` holds `email`/`otp`/`sent`/`error`/`resendCooldownSeconds` locally; OTP input is normalized (strips spaces/dashes), auto-focuses on send, and enforces a 30s resend cooldown.
- **Redirect-state round-trip**: `ProtectedRoute` stores `state.from` on redirect to `/sign-in`; `EmailOtpForm` reads `location.state.from` and returns the user to the original dashboard path (preserving search/hash) after a successful sign-in, defaulting to `/dashboard`.

## Flow

### Routing (`App.tsx`)
- `/` → `LandingPage`
- `/sign-in/*` → `SignInPage` (renders `AuthFormPanel` → `EmailOtpForm`)
- `/sign-up/*` → `<Navigate to="/sign-in" replace />`
- `/dashboard` → `AuthProviders → ProtectedRoute → DashboardStepUpGate → DashboardLayout` with nested children: index (`Wallet`), `api-keys`, `transactions`, `notifications`, `billing`, `docs`
- `*` → `<Navigate to="/" replace />`
- All routes wrapped in `ErrorBoundary` (from `src/main.tsx`) and a top-level `<Suspense>` with `PageFallback`.

### Public → auth → dashboard boundary
1. Unauthenticated user hits `/dashboard` → `ProtectedRoute` redirects to `/sign-in` with `state.from`.
2. `SignInPage` renders the split-layout shell; `AuthFormPanel` mounts `OpenfortAuthProvider` + `PublicOnlyRoute` (keeps already-authenticated users out) + `EmailOtpForm`.
3. `EmailOtpForm` calls `requestEmailOtp` → user enters code → `signInEmailOtp` → on success `navigate(getPostSignInPath(location.state), { replace: true })` back to the original dashboard path.
4. Authenticated user re-visits `/sign-in` → `PublicOnlyRoute` redirects back to `/dashboard`.

### Dashboard subtree boundary
The `dashboard/` directory is a self-contained authenticated subtree with its own routing, state, and API integration, fully documented in `dashboard/codemap.md`. Key boundary facts: `DashboardLayout` renders the `<Outlet />` for all nested dashboard routes; every page uses the token-accessor pattern (`getAccessToken` from `useUser`) against `@/lib/api` `*Auth` helpers; guarded mutations require a TOTP step-up proof (`step-up-session.ts`); `DashboardStepUpGate` (in `src/components/`) enforces MFA before the layout mounts.

## Integration
- **Routing**: `App.tsx` lazy-imports `Landing`, `SignIn`, and all dashboard pages; `SignIn` lazy-imports `AuthFormPanel` from `src/components/`.
- **Auth**: `@openfort/react` — `useEmailOtpAuth` (`requestEmailOtp`, `signInEmailOtp`, `isRequesting`, `isLoading`) in `EmailOtpForm`; `useOpenfort`/`useUser` used by the guards and dashboard pages.
- **Shared components**: `AuthFormPanel`, `ProtectedRoute`, `PublicOnlyRoute`, `AuthProviders`, `DashboardStepUpGate`, `ErrorBoundary` (all in `src/components/`).
- **API layer**: pages themselves make no direct API calls; the dashboard subtree consumes `@/lib/api` `*Auth` helpers, and `DEFAULT_CHAIN_ID` is sourced from `src/lib/api` by `AuthProviders`.
- **Env**: `VITE_OPENFORT_PUBLISHABLE_KEY` (required for sign-in), `VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY` (wallet recovery, dashboard).
- **Cross-cutting**: `EmailOtpForm` is the single shared auth form, referenced by `AuthFormPanel` and documented in `src/components/codemap.md`; the dashboard subtree's `step-up-session.ts` and `notification-events.ts` are consumed by `src/components/` guards.

## Security notes
- Public pages never touch private keys or API keys; they only drive the Openfort email-OTP flow.
- `PublicOnlyRoute` prevents authenticated users from re-entering the sign-in flow.
- The dashboard subtree (see its codemap) enforces TOTP step-up for guarded mutations and never persists raw API keys.
