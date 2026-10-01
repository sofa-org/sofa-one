# Dashboard Pages

## Responsibility

Authenticated, post-sign-in screens for the SOFA ONE agent wallet: wallet provisioning and chain authorization, balances and withdrawals, API key lifecycle management, transaction/signing history, security notifications, billing (plan/usage/invoices + card & USDC payment), and public API reference docs. All data comes from backend endpoints that require an Openfort IAM bearer token (frontend-only routes); API keys are only ever _displayed_ here, never used for dashboard calls.

## File inventory

- `DashboardLayout.tsx` — shell with sidebar/mobile drawer, nav, unread-alert badge, sign-out.
- `Wallet.tsx` — the `/dashboard` index page; wallet setup, agent registration, balances, withdrawals.
- `ApiKeys.tsx` — `/dashboard/api-keys`; create/revoke/rotate keys, status filter, quick-start curl.
- `Transactions.tsx` — `/dashboard/transactions`; paginated transaction + signing-request history with detail drawer.
- `SecurityNotifications.tsx` — `/dashboard/notifications`; security alert list, mark read/all-read.
- `Billing.tsx` — `/dashboard/billing`; current plan, usage summary, cost estimate, invoices, Stripe checkout.
- `UsdcPaymentPanel.tsx` — inline USDC payment flow for an eligible invoice (quote → pay-from-wallet with step-up + status poll, or manual claim; BILL-003 user cancel of clean pending quotes only).
- `Docs.tsx` — `/dashboard/docs`; static public API reference (sign/send/status).
- `components/DashboardPage.tsx` — shared page header + card primitives.
- `Step1CreateEoa.tsx`, `Step2AuthorizeAccess.tsx` — wallet setup sub-forms (password entry; network/expiry/password + submit).
- `BalanceDisplay.tsx`, `WithdrawForm.tsx` — balances grid and withdrawal form with allowlist management.
- `ApiKeyBanner.tsx`, `AuthorizationBadges.tsx`, `SetupStatusBanner.tsx`, `WalletLoadingState.tsx`, `WalletIcons.tsx` — presentational helpers.
- `wallet-helpers.ts` — pure helpers + constants for wallet/agent flows (amount parsing, gas price RPC, chain storage, expiry formatting).
- `step-up.ts`, `step-up-session.ts` — TOTP step-up challenge and session-scoped proof token cache.
- `notification-events.ts` — tiny window-event bus so the layout badge refreshes when alerts change.

## Design/Patterns

- **Container pages with local state**: each page is a default-exported component holding its own fetch/loading/error state; no global store. Data fetching uses `useCallback` loaders + `useEffect` with `AbortController` cleanup; retry is a nonce bump that re-runs the effect.
- **Shared layout via nested routes**: `DashboardLayout` renders `<Outlet />`; `App.tsx` mounts it under `/dashboard` wrapped in `AuthProviders → ProtectedRoute → DashboardStepUpGate`. All dashboard pages are `lazy()`-loaded.
- **Token accessor pattern**: every page builds `getToken = useCallback(async () => getAccessToken()...)` from `useUser()` and passes it to `@/lib/api` helpers; pages bail out when `!isAuthenticated`.
- **Step-up gating**: guarded mutations (withdraw, allowlist add/remove, API key create/revoke/rotate, USDC pay-from-wallet) call `getDashboardStepUpToken() ?? await requestStepUpToken(getToken)`; the proof token is cached in `sessionStorage` (`step-up-session.ts`) and cleared on sign-out. Payment-status polls do not require step-up.
- **Controlled forms**: key creation, withdrawal, and allowlist forms lift all field state to the page and pass setters down to presentational components.
- **Presentational split**: `Wallet.tsx` owns all logic; `Step1CreateEoa`/`Step2AuthorizeAccess`/`BalanceDisplay`/`WithdrawForm` are dumb props-driven components.
- **Stale-response guards**: request-id refs (`UsdcPaymentPanel`, `Billing.refreshInvoicesSilently`) and `isMountedRef` prevent out-of-order responses from clobbering state.
- **Local persistence**: chain selection (`sofa-one.wallet.balanceChainId`, `sofa-one.wallet.agentChainId`) and key status filter (`sofa-one.apiKeys.statusFilter`) in `localStorage`; step-up proof in `sessionStorage`.
- **One-time raw key display**: raw API keys are shown in an amber banner with a 2-minute auto-hide TTL (`RAW_KEY_NOTICE_TTL_MS`); never persisted.

## Flow

### Routing (`App.tsx`)

`/dashboard` (index → `WalletPage`), `api-keys`, `transactions`, `notifications`, `billing`, `docs` — all children of `DashboardLayout`. `DashboardStepUpGate` (in `src/components/`) enforces MFA before the layout mounts; it imports `step-up-session.ts` for proof handling.

### DashboardLayout

Renders desktop sidebar + mobile drawer from `NAV_ITEMS` (Wallet, API Keys, History, Alerts, Billing, API Docs). On mount (and on `sofa:security-notifications-changed` events) fetches unread alert count via `listSecurityNotificationsAuth` for the Alerts badge. Sign-out clears the step-up proof, calls `signOut()`, and navigates to `/sign-in`.

### Wallet (`/dashboard`)

1. Loads session via `getMe`; on `NOT_FOUND`/`WALLET_NOT_FOUND` falls back to `syncSession`. Stores `wallet` and one-time `apiKeyDisplay`.
2. **Step 1 (no EOA)**: `Step1CreateEoa` collects a recovery password; `handleConnectWallet` creates an Openfort embedded EOA (`AccountTypeEnum.EOA`, `RecoveryMethod.PASSWORD`), retries `authorizeEmbeddedWallet` up to 5×, and refreshes embedded accounts.
3. **Step 2 (EOA exists)**: `Step2AuthorizeAccess` picks chain + expiry (≤30 days) + password. `handleRegisterAgent` verifies Calibur deployment on the chain, checks native gas (unless `VITE_OPENFORT_FEE_SPONSORSHIP_ID`), validates the agent key hash, builds `encodeRegisterKey` + `encodeUpdateKeySettings` self-calls, signs an EIP-7702 authorization via `use7702Authorization`, and submits a Calibur UserOp through Openfort (or Pimlico on Monad) bundler. Then `markAgentRegistrationTransaction` + `confirmAgentRegistration` poll the receipt and `markAgentRegistrationResult` (retrying on `AGENT_REGISTRATION_PENDING`).
4. **Balances**: `getBalancesAuth` per selected chain; refresh nonce + retry button.
5. **Withdraw**: `WithdrawForm` manages the allowlist (`listWithdrawalAddressesAuth`/`addWithdrawalAddressAuth`/`removeWithdrawalAddressAuth`, each step-up gated) and submits `withdrawAuth` with parsed base units (`parseWithdrawalAmount`).

### ApiKeys (`/dashboard/api-keys`)

Lists keys (sorted: active by soonest expiry then last-used; revoked by newest), filters by status, enforces the 10-active-key cap. Create sends name, optional IP/contract/selector allowlists, spend limits, and permission checkboxes; shows the raw key once. Revoke (per-key), rotate-all (`refreshApiKey`), and emergency revoke-all are all confirm-gated and step-up gated. Includes a backend-only curl quick start.

### Transactions (`/dashboard/transactions`)

Two tabs: transactions (`listTransactionsAuth`) and signing requests (`listSigningRequestsAuth`), each with status/type/chain filters, 20-per-page pagination, and refresh. Row click opens a slide-over drawer that fetches detail (`getTransactionDetailAuth`/`getSigningRequestDetailAuth`) with retry; Escape/backdrop close and body scroll is locked while open.

### SecurityNotifications (`/dashboard/notifications`)

Fetches `listSecurityNotificationsAuth`, sorts newest-first, renders risk badges and humanized metadata details. Mark-read and mark-all-read call the API then optimistically update local state and fire `notifySecurityNotificationsChanged()` so the layout badge updates.

### Billing (`/dashboard/billing`)

Loads plans, period-scoped usage summary, and invoices in parallel. Period picker (UTC month) refetches the summary. Stripe card checkout: `createBillingCheckoutSessionAuth` → redirect to `checkoutUrl`; `?success`/`?canceled` search params render a notice then are stripped. USDC payment opens `UsdcPaymentPanel` inline; a silent invoice refresh (`refreshInvoicesSilently`, abort + request-id guarded) runs after claims and the panel auto-closes once the invoice is paid. Payability is gated client-side (`isInvoicePayableByCard`/`isInvoicePayableByUsdc`) with the backend as final authority. **BILL-003**: card stays locked while an active USDC rail/reservation exists; invoice-list banner offers **Cancel quote** only for clean pending (unreserved) USDC attempts via `cancelUsdcQuoteAuth` (confirm + loading + 409 refresh); confirming/reserved/review never show cancel.

### UsdcPaymentPanel

Selects Base/Ethereum mainnet/Sepolia, fetches a quote (`createUsdcQuoteAuth`), and displays **server-derived** quote facts only (exact amount/base units, token contract, chain, expected payer, treasury, expiry with 5-minute safety warning). Primary action is user-triggered **Pay from wallet** (`payUsdcFromWalletAuth` with `X-Step-Up-Token` via existing `requestStepUpToken` / session proof) — body is `paymentAttemptId` only; never auto-submits. Status is restored and polled via `getUsdcPaymentStatusAuth` (no step-up). Phases distinguish accepted/submitting, confirming, unknown/manual review, failed, and paid — **`paid: true` alone** settles the UI; accepted/hash/202-shaped responses never imply invoice paid. Duplicate pay/claim are locked while reserved/submitting/unknown/confirming. **Fail-closed recovery (B5)**: status restore/check failure or ambiguous pay POST (network/timeout/5xx) enters local recovery — keeps pay/manual claim locked, shows status-unconfirmed copy, allows only Check status; successful authoritative status clears recovery; quote refresh must not unlock a second payment. Secondary path keeps manual tx-hash claim (`createUsdcClaimAuth`). **BILL-003 Cancel quote**: only for clean pending (unreserved, evidence-free) attempts — shown on idle quote and continue-entry pending; hidden for confirming/reserved/recovery/review/terminal. Confirm dialog, loading lock, anti double-submit; success clears local quote and refreshes invoice payment status; 409 `USDC_CANCEL_NOT_ALLOWED` (and related) shows safe conflict copy and refreshes status without inventing cancel success. Safe error mapping covers expiry-too-soon, usage-debt, cooldown/allowlist, cancel-not-allowed, frozen/origin/step-up failures without provider IDs or calldata.

### Docs (`/dashboard/docs`)

Static reference for the three public API-key endpoints (`/v1/wallets/sign`, `/v1/transactions/send`, `/v1/transactions/:id`): field tables, curl examples, supported networks from `SUPPORTED_CHAINS`, and error-format notes. Base URL comes from `getApiBaseUrlForDisplay`/`getApiBaseUrlModeLabel` (Vite proxy vs `VITE_API_URL`).

## Integration

- **Routing**: mounted by `frontend/src/App.tsx` under `/dashboard` (lazy imports); guarded by `ProtectedRoute` and `DashboardStepUpGate`; `DashboardLayout` provides the `<Outlet />`.
- **Auth**: `@openfort/react` — `useUser` (`getAccessToken`, `isAuthenticated`, `user`), `useOpenfort`, `useSignOut`, `useEthereumEmbeddedWallet`, `use7702Authorization`.
- **API layer**: `@/lib/api` — all `*Auth` helpers (wallet, keys, notifications, transactions, billing, USDC, TOTP), `getApiErrorMessage`/`hasApiErrorCode`/`isApiError`, `DEFAULT_CHAIN_ID`, and response types.
- **Chains**: `@/lib/chains` — `SUPPORTED_CHAINS`, explorer/gas-help URL builders, `getNativeCurrencySymbol`, `isMonadChain`.
- **Calibur**: `@/lib/calibur` — `CALIBUR_ADDRESSES`, `CALIBUR_DELEGATION_CODES`, `hashKey`, `encodeRegisterKey`, `encodeUpdateKeySettings`, `encodeSelfCall`, `createCaliburAccount`.
- **Wallet stack**: `viem` (public client, `padHex`, `zeroAddress`), `viem/account-abstraction` (bundler/paymaster clients), `wagmi` (`usePublicClient`).
- **Shared UI**: `@/components/CopyButton`; `DashboardStepUpGate` (in `src/components/`) consumes `step-up-session.ts`.
- **Env**: `VITE_OPENFORT_PUBLISHABLE_KEY`, `VITE_OPENFORT_FEE_SPONSORSHIP_ID`, `VITE_PIMLICO_API_KEY`/`VITE_PIMLICO_RPC_URL_<chainId>`.
- **Cross-page coupling**: `notification-events.ts` keeps the layout badge and the notifications page in sync; `step-up-session.ts` is shared by Wallet, ApiKeys, and `DashboardStepUpGate`.

## Security notes

- Private keys never leave Openfort; the dashboard only handles the recovery password (browser-local, never stored/returned) and signs via the embedded wallet.
- Raw API keys are shown once with a 2-minute TTL and are never persisted; docs and quick-start emphasize backend-only storage.
- Guarded mutations require a TOTP step-up proof token (session-scoped, expiry-checked, cleared on sign-out).
- Withdrawals enforce an allowlist + cooldown policy; recipient inputs validate `^0x[a-fA-F0-9]{40}$`.
- Public status responses (Docs) intentionally omit calldata/request hashes.
