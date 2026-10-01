# Shared Components (`frontend/src/components/`)

## Responsibility
Reusable React components for the SOFA ONE SPA: Openfort auth provider wiring, route-level auth gating (sign-in protection, public-only redirect, dashboard MFA step-up), error handling, config diagnostics, and a clipboard utility. No business/API logic lives here; components compose `@openfort/react`, React Router, and `src/lib/api` helpers.

## Component inventory

### AuthProviders.tsx
- **Responsibility**: Full provider stack for the authenticated dashboard tree. Validates Openfort env config up front and renders `OpenfortConfigError` if `VITE_OPENFORT_PUBLISHABLE_KEY` or `VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY` is missing.
- **Design/Patterns**: Provider composition (wrapper) pattern. Module-level singletons: `QueryClient`, `wagmiConfig` built once via `getDefaultConfig` from `@openfort/react/wagmi` with 13 viem chains (baseSepolia, base, mainnet, sepolia, polygon, polygonAmoy, arbitrum, optimism, optimismSepolia, bsc, bscTestnet, monad, monadTestnet), each with an `http()` transport defaulting to public RPCs and overridable via `VITE_*_RPC_URL` env vars.
- **Flow**: `QueryClientProvider` → `WagmiProvider` → `OpenfortWagmiBridge` → `OpenfortProvider` → `children`. `OpenfortProvider` config: EVM chain type, EOA account type on `DEFAULT_CHAIN_ID` (84532 from `src/lib/api`), `connectOnLogin: false`, Shield publishable key for wallet recovery, `uiConfig` with `EMAIL_OTP` auth provider and `PASSWORD` default recovery method.
- **Integration**: Lazy-loaded in `App.tsx`; wraps the `/dashboard` route tree. Depends on `@openfort/react`, `@openfort/react/wagmi`, `wagmi`, `viem/chains`, `@tanstack/react-query`, `DEFAULT_CHAIN_ID` from `src/lib/api`, and `OpenfortConfigError`.

### OpenfortAuthProvider.tsx
- **Responsibility**: Minimal Openfort provider for the public sign-in flow (no Wagmi/Shield). Renders `OpenfortConfigError` when `VITE_OPENFORT_PUBLISHABLE_KEY` is missing.
- **Design/Patterns**: Thin wrapper around `OpenfortProvider` with `EMAIL_OTP` auth provider only.
- **Flow**: Validates env → `OpenfortProvider` → `children`.
- **Integration**: Consumed by `AuthFormPanel`. Depends on `@openfort/react` and `OpenfortConfigError`.

### AuthFormPanel.tsx
- **Responsibility**: Composition root for the sign-in form area.
- **Design/Patterns**: Nested wrapper composition.
- **Flow**: `OpenfortAuthProvider` → `PublicOnlyRoute` → `EmailOtpForm` (from `src/pages/EmailOtpForm`).
- **Integration**: Lazy-loaded by `src/pages/SignIn.tsx` (`/sign-in/*` route). Depends on `OpenfortAuthProvider`, `PublicOnlyRoute`, `EmailOtpForm`.

### ProtectedRoute.tsx
- **Responsibility**: Route guard for authenticated-only pages.
- **Design/Patterns**: Conditional render guard using `useOpenfort()` (`isLoading`, `user`).
- **Flow**: If `user` → render `children`. If `isLoading` → centered "Checking your Openfort session" spinner with reload button. Else → `<Navigate to="/sign-in" replace state={{ from: location }} />` so the sign-in flow can return the user to the original dashboard path.
- **Integration**: Lazy-loaded in `App.tsx`; wraps `DashboardStepUpGate` inside the `/dashboard` route. Depends on `@openfort/react` and `react-router-dom`.

### PublicOnlyRoute.tsx
- **Responsibility**: Route guard for public pages; keeps already-authenticated users out of sign-in.
- **Design/Patterns**: Conditional render guard with redirect-state parsing (`getDashboardRedirectPath`).
- **Flow**: If `isLoading` → compact "Account check" spinner panel. If `user` → `<Navigate>` to the `location.state.from` path when it starts with `/dashboard` (preserving search/hash), otherwise `/dashboard`. Else → render `children`.
- **Integration**: Used by `AuthFormPanel` for the sign-in page. Depends on `@openfort/react` and `react-router-dom`.

### DashboardStepUpGate.tsx
- **Responsibility**: MFA step-up gate for the dashboard. Blocks `children` until the user has a valid TOTP proof for the session; provisions MFA on first use.
- **Design/Patterns**: State-machine gate with stages `checking | setup | verify | recovery | ready | error`. Bootstrap effect runs `syncSession` → `getMfaStatusAuth`; if MFA disabled, calls `setupTotpAuth` and shows QR setup; if enabled, shows verify form. Proof persistence via `sessionStorage` helpers in `src/pages/dashboard/step-up-session.ts` (`getDashboardStepUpToken` short-circuits to `ready` when a non-expired proof exists). QR code rendered client-side via `qrcode` `toDataURL`. Digit/part input handling with refs for auto-advance, backspace, and paste; recovery codes normalized to `[A-HJ-NP-Z2-9]` (Crocker-Ford base32) in 3×4-char parts.
- **Flow**: `checking` → (`setup` → `recovery` → `ready`) or (`verify` → `ready`); `error` on API failure with retry. `ready` renders `children`. Verification calls `enableTotpAuth` (setup path) or `verifyTotpAuth` (verify/recovery path), then `storeDashboardStepUpProof` before advancing.
- **Integration**: Lazy-loaded in `App.tsx`; wraps `DashboardLayout` inside `ProtectedRoute`. Depends on `useUser` from `@openfort/react`, API helpers `syncSession`/`getMfaStatusAuth`/`setupTotpAuth`/`enableTotpAuth`/`verifyTotpAuth`/`getApiErrorMessage` and types `MfaStatusResponse`/`TotpSetupResponse` from `src/lib/api`, `step-up-session` helpers, `CopyButton`, `qrcode`, `lucide-react`.

### ErrorBoundary.tsx
- **Responsibility**: Top-level render error boundary for the whole SPA.
- **Design/Patterns**: Class component with `getDerivedStateFromError` + `componentDidCatch` (logs `console.error` with component stack). Error details string (time, timezone, path, UA, language, error; stack only in dev) exposed via `CopyButton`.
- **Flow**: On error → full-screen error card with "Reload app", "Back to dashboard" (`window.location.assign('/dashboard')`), "Try without reload" (clears error state), and copy-details button. Otherwise renders `children`.
- **Integration**: Wraps the entire app in `src/main.tsx`. Depends on `CopyButton` and `lucide-react`.

### OpenfortConfigError.tsx
- **Responsibility**: Full-screen diagnostic when required Openfort env vars are missing.
- **Design/Patterns**: Presentational component keyed on `missingVars: string[]`. Categorizes vars into sign-in (`VITE_OPENFORT_PUBLISHABLE_KEY`), wallet setup (`VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY`), and other buckets with per-var help text; renders a copyable `.env` template via `CopyButton`.
- **Flow**: Renders missing-var list, "what these unlock" sections, local setup steps, optional RPC override note, and copyable env entries.
- **Integration**: Rendered by `AuthProviders` and `OpenfortAuthProvider` on config failure. Depends on `CopyButton` and `lucide-react`.

### CopyButton.tsx
- **Responsibility**: Clipboard copy button with visual feedback.
- **Design/Patterns**: State machine `idle | copied | error` with a 2s auto-reset timeout (cleared on unmount). Clipboard strategy: `navigator.clipboard.writeText` first, falling back to a hidden `<textarea>` + `document.execCommand('copy')` for insecure contexts/permission failures.
- **Flow**: Click → copy → `copied` (green) or `error` (red) → reset to `idle`. Icons from `lucide-react` (`Copy`/`Check`/`X`); `aria-label`/`title` reflect state.
- **Integration**: Consumed across the app: `DashboardStepUpGate`, `ErrorBoundary`, `OpenfortConfigError`, and dashboard pages (`DashboardLayout`, `Wallet`, `ApiKeys`, `ApiKeyBanner`, `Transactions`, `Docs`, `WithdrawForm`, `UsdcPaymentPanel`, `Step2AuthorizeAccess`). Depends on `lucide-react`.

## Route protection summary
- `/dashboard/*` (in `App.tsx`): `AuthProviders` → `ProtectedRoute` → `DashboardStepUpGate` → `DashboardLayout` (all lazy-loaded). Unauthenticated users are redirected to `/sign-in` with `state.from`; authenticated users without a session MFA proof are held at the step-up gate.
- `/sign-in/*`: `SignInPage` lazy-loads `AuthFormPanel` (`OpenfortAuthProvider` → `PublicOnlyRoute` → `EmailOtpForm`); authenticated users are redirected back to `/dashboard`.
- `/sign-up/*` and unknown paths redirect to `/sign-in` and `/` respectively.
- `ErrorBoundary` wraps the entire app in `main.tsx`.

## Dependencies
- `@openfort/react` (providers, `useOpenfort`, `useUser`), `@openfort/react/wagmi` (`getDefaultConfig`, `OpenfortWagmiBridge`), `wagmi` + `viem/chains`, `@tanstack/react-query`, `react-router-dom`, `qrcode`, `lucide-react`.
- `src/lib/api` (`DEFAULT_CHAIN_ID`, MFA/TOTP helpers and types, `getApiErrorMessage`), `src/pages/dashboard/step-up-session.ts` (sessionStorage proof), `src/pages/EmailOtpForm`.
- Env vars: `VITE_OPENFORT_PUBLISHABLE_KEY`, `VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY`, optional `VITE_*_RPC_URL` overrides.