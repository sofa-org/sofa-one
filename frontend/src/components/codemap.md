# Shared Components (`frontend/src/components/`)

## Responsibility
Shared application-session state, route/MFA gates, wallet-only Openfort provider wiring, error/config diagnostics and UI utilities. AppSessionProvider owns server introspection/exchange/logout; wallet keys remain entirely in Openfort.

## Component inventory

### AppSessionProvider.tsx
- Root local-session context exposes snapshot/loading/error, refresh, explicit IAM exchange and current/all-device logout.
- Transport uses cookies plus in-memory CSRF. Cookie 401/absolute expiry clears session/proof state; 403/5xx preserve state with retry. Focus/visibility introspection cannot supersede in-flight login exchange.
- Session ID replacement remounts protected content and clears proof cache; cached proofs never authenticate users.

### AuthProviders.tsx
- **Responsibility**: Wallet-route-only Wagmi/Shield/Openfort provider stack. Missing wallet configuration does not block non-wallet dashboard routes.
- **Design/Patterns**: Provider composition (wrapper) pattern. Module-level singletons: `QueryClient`, `wagmiConfig` built once via `getDefaultConfig` from `@openfort/react/wagmi` with 13 viem chains (baseSepolia, base, mainnet, sepolia, polygon, polygonAmoy, arbitrum, optimism, optimismSepolia, bsc, bscTestnet, monad, monadTestnet), each with an `http()` transport defaulting to public RPCs and overridable via `VITE_*_RPC_URL` env vars.
- **Flow**: `QueryClientProvider` → `WagmiProvider` → `OpenfortWagmiBridge` → `OpenfortProvider` → `children`. `OpenfortProvider` config: EVM chain type, EOA account type on `DEFAULT_CHAIN_ID` (84532 from `src/lib/api`), `connectOnLogin: false`, Shield publishable key for wallet recovery, `uiConfig` with `EMAIL_OTP` auth provider and `PASSWORD` default recovery method.
- **Integration**: Lazy-loaded only around the dashboard index WalletPage in App.tsx; non-wallet pages use AppSessionProvider without Openfort context.

### OpenfortAuthProvider.tsx
- **Responsibility**: Minimal Openfort provider for the public sign-in flow (no Wagmi/Shield). Renders `OpenfortConfigError` when `VITE_OPENFORT_PUBLISHABLE_KEY` is missing.
- **Design/Patterns**: Thin wrapper around `OpenfortProvider` with `EMAIL_OTP` auth provider only.
- **Flow**: Validates env → `OpenfortProvider` → `children`.
- **Integration**: Consumed by `AuthFormPanel`. Depends on `@openfort/react` and `OpenfortConfigError`.

### AuthFormPanel.tsx
- **Responsibility**: Composition root for the sign-in form area.
- **Design/Patterns**: Nested wrapper composition.
- **Flow**: `PublicOnlyRoute` → `OpenfortAuthProvider` → `EmailOtpForm`; local sessions redirect before mounting provider configuration.
- **Integration**: Lazy-loaded by `src/pages/SignIn.tsx` (`/sign-in/*` route). Depends on `OpenfortAuthProvider`, `PublicOnlyRoute`, `EmailOtpForm`.

### ProtectedRoute.tsx
- **Responsibility**: Route guard for authenticated-only pages.
- **Design/Patterns**: Uses AppSessionProvider snapshot/loading/error, with retry instead of sign-out on service outages.
- **Flow**: Live local snapshot renders session-keyed children; absent session redirects with state.from; pending MFA remains behind DashboardStepUpGate.
- **Integration**: Wraps the dashboard layout without Openfort dependencies.

### PublicOnlyRoute.tsx
- **Responsibility**: Route guard for public pages; keeps already-authenticated users out of sign-in.
- **Design/Patterns**: Conditional render guard with redirect-state parsing (`getDashboardRedirectPath`).
- **Flow**: Restores the SOFA snapshot before rendering sign-in; authenticated users return to a dashboard path, otherwise children render. Outages offer retry.
- **Integration**: Uses AppSessionProvider and React Router; no Openfort-context dependency.

### DashboardStepUpGate.tsx
- **Responsibility**: Server-authoritative MFA gate; cached proofs never bypass pending MFA.
- **Design/Patterns**: checking/setup/verify/recovery/ready/error states. Pending sessions query MFA status and set up or verify; full-MFA snapshots render children. QR and recovery-code UX is preserved.
- **Flow**: Enable then verify the factor, refresh and confirm the same server session upgraded, cache proof with its originating session ID. Initial recovery codes require explicit acknowledgement before entry.
- **Integration**: Uses AppSessionProvider and cookie-auth API helpers; no Openfort hook or login exchange during dashboard bootstrap.

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
- `/dashboard/*`: root AppSessionProvider → ProtectedRoute → DashboardStepUpGate → DashboardLayout; only the wallet index mounts AuthProviders.
- `/sign-in/*`: PublicOnlyRoute → OpenfortAuthProvider → EmailOtpForm; successful OTP explicitly exchanges identity before dashboard navigation.
- `/sign-up/*` and unknown paths redirect to `/sign-in` and `/` respectively.
- `ErrorBoundary` wraps the entire app in `main.tsx`.

## Dependencies
- `@openfort/react` (providers, `useOpenfort`, `useUser`), `@openfort/react/wagmi` (`getDefaultConfig`, `OpenfortWagmiBridge`), `wagmi` + `viem/chains`, `@tanstack/react-query`, `react-router-dom`, `qrcode`, `lucide-react`.
- `src/lib/api` (`DEFAULT_CHAIN_ID`, MFA/TOTP helpers and types, `getApiErrorMessage`), `src/pages/dashboard/step-up-session.ts` (sessionStorage proof), `src/pages/EmailOtpForm`.
- Env vars: `VITE_OPENFORT_PUBLISHABLE_KEY`, `VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY`, optional `VITE_*_RPC_URL` overrides.